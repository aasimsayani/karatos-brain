import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * A small client for Docusign's eSignature REST API (v2.1). It signs in with
 * JWT Grant, as a server does, and then sends only reads: the signed-in
 * user's accounts, to find the account's API address, and the account's
 * envelopes with their recipients. It never downloads a document.
 *
 * Docusign has no read-only scope: JWT Grant asks for `signature
 * impersonation`, which is what every eSignature call needs, reads and
 * sends alike. So the user the connector signs in as should be one that
 * can't send envelopes (see docs/integrations/docusign.md), and the client
 * itself sends only the token request and its two GETs.
 */

/** Docusign's sign-in hosts, the JWT audience for each. */
export const DOCUSIGN_ACCOUNT_HOSTS = { production: "account.docusign.com", developer: "account-d.docusign.com" } as const;
export type DocusignEnvironment = keyof typeof DOCUSIGN_ACCOUNT_HOSTS;
/** What JWT Grant asks for: the only scope eSignature has, and impersonation, which JWT needs. */
export const DOCUSIGN_SCOPES = "signature impersonation";
export const DOCUSIGN_API_PATH = "/restapi/v2.1";
/** Envelopes per page. Docusign allows up to 1,000; smaller pages checkpoint more often. */
export const DOCUSIGN_PAGE_SIZE = 100;
/** A JWT Grant token lasts an hour; a new one is asked for this long before then. */
const TOKEN_MARGIN_MS = 15 * 60_000;
const MAX_RETRY_AFTER_S = 60;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ERROR_CODE = /^[A-Za-z_]{1,80}$/;

/** A Docusign id (integration key, user, account or envelope) in lowercase, or undefined when it isn't a GUID. */
export function docusignGuid(value: unknown): string | undefined {
  return typeof value === "string" && GUID.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

export class DocusignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocusignConfigError";
  }
}

export class DocusignApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DocusignApiError";
  }
}

/**
 * The RSA private key of the integration's key pair: as Docusign gives it
 * (PEM, with real line breaks or `\n`), or that PEM base64-encoded on one
 * line, which is easier to keep in a host's settings.
 */
export function docusignPrivateKey(value: string | undefined): KeyObject {
  const raw = value?.trim() ?? "";
  const pem = raw.startsWith("-----BEGIN") ? raw.replace(/\\n/g, "\n") : /^[A-Za-z0-9+/=\s]{100,20000}$/.test(raw) ? Buffer.from(raw, "base64").toString("utf8") : "";
  let key: KeyObject | undefined;
  try {
    key = pem.startsWith("-----BEGIN") ? createPrivateKey(pem) : undefined;
  } catch {
    key = undefined;
  }
  if (!key || key.asymmetricKeyType !== "rsa") throw new DocusignConfigError("DOCUSIGN_PRIVATE_KEY must be the integration's RSA private key, as Docusign gives it or base64-encoded");
  return key;
}

export interface DocusignClientOptions {
  /** The app's integration key (client id). */
  integrationKey: string;
  /** The Docusign user the connector signs in as, by user id. */
  userId: string;
  /** The Docusign account whose envelopes are read, by account id. */
  accountId: string;
  /** The integration's RSA private key; see docusignPrivateKey. Sent nowhere: it only signs the sign-in request. */
  privateKey: string;
  environment?: DocusignEnvironment;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  now?: () => Date;
}

export interface EnvelopeQuery {
  /** Envelopes whose status changed at or after this UTC time. */
  from: string;
  /** Only envelopes now in one of these statuses. Every status otherwise. */
  status?: readonly ("sent" | "delivered")[];
  orderBy: "status_changed" | "created";
  /** Zero-based position of the first envelope. */
  start: number;
}

export interface EnvelopePage {
  data: Record<string, unknown>[];
  /** Envelopes in the whole result. */
  total: number;
}

export interface DocusignClient {
  /** One page of the account's envelopes, oldest first, each with its recipients. */
  envelopes(query: EnvelopeQuery): Promise<EnvelopePage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** Docusign writes counts as strings. */
const count = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** Seconds from a Retry-After header, or undefined when it doesn't read as seconds. */
function retryAfter(value: string | null): number | undefined {
  return value !== null && /^\d{1,6}$/.test(value.trim()) ? Number(value) : undefined;
}

/** An account's API address as Docusign gives it: https on a docusign.net host, nothing else. */
export function docusignBaseUri(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const ok = url.protocol === "https:" && /^([a-z0-9-]+\.)+docusign\.net$/.test(url.hostname) && !url.port && !url.username && !url.password && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
  return ok ? url.origin : undefined;
}

export function docusignClient(options: DocusignClientOptions): DocusignClient {
  const integrationKey = docusignGuid(options.integrationKey);
  if (!integrationKey) throw new DocusignConfigError("DOCUSIGN_INTEGRATION_KEY must be the app's integration key, a GUID");
  const userId = docusignGuid(options.userId);
  if (!userId) throw new DocusignConfigError("DOCUSIGN_USER_ID must be the user's API user id, a GUID");
  const accountId = docusignGuid(options.accountId);
  if (!accountId) throw new DocusignConfigError("DOCUSIGN_ACCOUNT_ID must be the account's API account id, a GUID");
  const environment = options.environment ?? "production";
  if (!Object.hasOwn(DOCUSIGN_ACCOUNT_HOSTS, environment)) throw new DocusignConfigError("DOCUSIGN_ENVIRONMENT must be production or developer");
  const key = docusignPrivateKey(options.privateKey);
  const host = DOCUSIGN_ACCOUNT_HOSTS[environment];
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const now = options.now ?? (() => new Date());

  let token: { value: string; until: number } | undefined;
  let base: string | undefined;

  /** Docusign's error code, when its body has one that reads. Never the message, which can echo what was sent. */
  const code = (reply: unknown) => {
    const c = isObject(reply) ? (reply.errorCode ?? reply.error) : undefined;
    return typeof c === "string" && ERROR_CODE.test(c) ? c : undefined;
  };

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const iat = Math.floor(now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({ iss: integrationKey, sub: userId, aud: host, iat, exp: iat + 3600, scope: DOCUSIGN_SCOPES }));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key).toString("base64url");
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` });
    const response = await fetch(`https://${host}/oauth/token`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status !== 200) {
      const why = code(reply);
      if (why === "consent_required") throw new DocusignConfigError("Docusign says the user hasn't consented to the app: sign in once as DOCUSIGN_USER_ID through the consent link in docs/integrations/docusign.md");
      if (why === "no_valid_keys_or_signatures") throw new DocusignConfigError("Docusign turned down the sign-in: DOCUSIGN_PRIVATE_KEY isn't a key of the app named by DOCUSIGN_INTEGRATION_KEY");
      if (why === "invalid_grant" || why === "user_not_found" || why === "issuer_not_found") throw new DocusignConfigError(`Docusign turned down the sign-in (${why}): check DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID and DOCUSIGN_ENVIRONMENT`);
      throw new DocusignApiError(`Docusign answered HTTP ${response.status} to the sign-in${why ? ` (${why})` : ""}`, response.status);
    }
    const value = isObject(reply) ? reply.access_token : undefined;
    const life = isObject(reply) ? count(reply.expires_in) : undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9._~+/=-]{20,8192}$/.test(value)) throw new DocusignApiError("Docusign's sign-in answer has no access token", 200);
    token = { value, until: now().getTime() + Math.max((life ?? 3600) * 1000 - TOKEN_MARGIN_MS, 0) };
    return value;
  }

  /** A GET with the current token. A 401 signs in again once; a 429 is waited out. */
  async function get(url: string, what: string): Promise<Record<string, unknown>> {
    let signedInAgain = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${await signIn()}`, Accept: "application/json" } });
      if (response.status === 429 && attempt < retries) {
        const wait = retryAfter(response.headers.get("retry-after"));
        await sleep(1000 * (wait !== undefined ? Math.min(Math.max(wait, 1), MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      const reply: unknown = await response.json().catch(() => undefined);
      if (response.status === 401 && !signedInAgain) {
        // The token may have been revoked or expired early; one new sign-in, then the error stands.
        signedInAgain = true;
        token = undefined;
        continue;
      }
      const why = code(reply);
      if (response.status === 401) throw new DocusignApiError(`Docusign turned down the access token for ${what}`, 401);
      if (response.status === 429) throw new DocusignApiError(`Docusign's rate limit stopped ${what}${why ? ` (${why})` : ""}; runSync tries again later`, 429);
      if (response.status !== 200) throw new DocusignApiError(`Docusign answered HTTP ${response.status} for ${what}${why ? ` (${why})` : ""}`, response.status);
      if (!isObject(reply)) throw new DocusignApiError(`Docusign answered ${what} with a body that isn't a JSON object`, 200);
      return reply;
    }
  }

  /** The account's API address, from the signed-in user's accounts. */
  async function account(): Promise<string> {
    if (base) return base;
    const info = await get(`https://${host}/oauth/userinfo`, "the user's accounts");
    const accounts = Array.isArray(info.accounts) ? info.accounts.filter(isObject) : [];
    const match = accounts.find((a) => docusignGuid(a.account_id) === accountId);
    if (!match) throw new DocusignConfigError("DOCUSIGN_USER_ID isn't a member of DOCUSIGN_ACCOUNT_ID: check both ids, and DOCUSIGN_ENVIRONMENT");
    const uri = docusignBaseUri(match.base_uri);
    if (!uri) throw new DocusignApiError("Docusign gave the account an API address that isn't an https docusign.net address", 200);
    base = uri;
    return uri;
  }

  return {
    async envelopes(query) {
      if (!ISO.test(query.from) || Number.isNaN(Date.parse(query.from)) || new Date(query.from).toISOString() !== query.from) throw new DocusignApiError("the changed-since time must be a UTC time", 0);
      if (!Number.isInteger(query.start) || query.start < 0 || query.start > 1_000_000) throw new DocusignApiError("the start position must be a whole number", 0);
      if (query.orderBy !== "status_changed" && query.orderBy !== "created") throw new DocusignApiError("envelopes are read by status change or creation only", 0);
      if (query.status && (query.status.length === 0 || !query.status.every((s) => s === "sent" || s === "delivered"))) throw new DocusignApiError("only envelopes out for signature are read by status", 0);
      const url = new URL(`${await account()}${DOCUSIGN_API_PATH}/accounts/${accountId}/envelopes`);
      url.searchParams.set("from_date", query.from);
      if (query.status) url.searchParams.set("status", query.status.join(","));
      url.searchParams.set("include", "recipients");
      url.searchParams.set("order_by", query.orderBy);
      url.searchParams.set("order", "asc");
      url.searchParams.set("count", String(DOCUSIGN_PAGE_SIZE));
      url.searchParams.set("start_position", String(query.start));
      const reply = await get(url.toString(), "the account's envelopes");
      // Docusign leaves the list out when nothing matches.
      if (reply.envelopes !== undefined && !Array.isArray(reply.envelopes)) throw new DocusignApiError("Docusign answered the account's envelopes with a list that isn't one", 200);
      const data = ((reply.envelopes as unknown[] | undefined) ?? []).map((e) => (isObject(e) ? e : {}));
      return { data, total: count(reply.totalSetSize) ?? data.length };
    },
  };
}
