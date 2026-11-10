/**
 * A small client for Microsoft Graph (v1.0): one drive's change feed, the
 * `driveItem: delta` of its root. It signs in as the app itself, with the
 * client credentials grant, and sends only two requests:
 *
 * - `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`;
 * - `GET https://graph.microsoft.com/v1.0/drives/{drive}/root/delta`.
 *
 * The app is meant to have `Sites.Selected` (or `Lists.SelectedOperations.Selected`)
 * with the `read` role granted on the one site or library to read, so it can
 * see nothing else and change nothing. When the token says which application
 * permissions it carries, the client stops if any isn't one of the read
 * permissions below.
 *
 * Graph's paging links are never fetched as given: the client reads the
 * delta token out of each one and builds the next request itself, so a
 * link can't send it, or its token, anywhere else.
 */

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";
export const MICROSOFT_GRAPH = "https://graph.microsoft.com/v1.0";
/** The application permissions a token may carry: the ones that read files, and nothing more. */
export const MICROSOFT_READ_ROLES = ["Sites.Selected", "Lists.SelectedOperations.Selected", "Files.SelectedOperations.Selected", "Files.Read.All", "Sites.Read.All"] as const;
/** The item fields asked for. People (createdBy, lastModifiedBy), sharing and links are never asked for. */
export const MICROSOFT_DELTA_SELECT = "id,name,size,file,folder,package,root,deleted,parentReference,createdDateTime,lastModifiedDateTime";
/** A new token is asked for this long before the current one ends. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_RETRY_AFTER_S = 60;
export const MICROSOFT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A drive id: `b!` and base64url for SharePoint and OneDrive for Business. */
export const MICROSOFT_DRIVE_ID = /^b![A-Za-z0-9_-]{20,200}$/;
/** A delta token, as Graph puts it in its paging links. */
export const MICROSOFT_DELTA_TOKEN = /^[A-Za-z0-9_.~=+/-]{1,8192}$/;
const ACCESS_TOKEN = /^[\x21-\x7e]{1,16384}$/;

export interface MicrosoftClientOptions {
  /** The directory (tenant) id (MICROSOFT_TENANT_ID). */
  tenantId: string;
  /** The app's client id (MICROSOFT_CLIENT_ID). */
  clientId: string;
  /** The app's client secret (MICROSOFT_CLIENT_SECRET). Sent to Microsoft only, and never logged or shown. */
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 503 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  now?: () => Date;
}

export class MicrosoftConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftConfigError";
  }
}

export class MicrosoftApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Graph's error code, such as `itemNotFound`, when it reads as one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "MicrosoftApiError";
  }
}

/** Graph wants the drive enumerated again (410 Gone). */
export class MicrosoftResyncError extends MicrosoftApiError {
  constructor(code?: string) {
    super("Microsoft Graph asked for the drive to be read again from the start", 410, code);
    this.name = "MicrosoftResyncError";
  }
}

export interface MicrosoftDeltaPage {
  items: Record<string, unknown>[];
  /** The token for the next page, when there is one. */
  next: string | null;
  /** The token for the next sync, on the last page. */
  delta: string | null;
}

export interface MicrosoftClient {
  /** One page of the drive's root delta: from the start when `token` is null. */
  delta(driveId: string, token: string | null): Promise<MicrosoftDeltaPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value)) return undefined;
  return Number(value);
}

/** A GUID setting, trimmed and lowercased, or undefined when it isn't one. */
export function microsoftGuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return MICROSOFT_GUID.test(v) ? v : undefined;
}

/** The application permissions a token says it carries, or undefined when it doesn't say. */
export function microsoftTokenRoles(token: string): string[] | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const roles = isObject(claims) ? claims.roles : undefined;
  return Array.isArray(roles) && roles.every((r) => typeof r === "string") ? (roles as string[]) : undefined;
}

/**
 * The delta token in one of Graph's paging links, or undefined unless the
 * link is this drive's root delta on Graph and carries nothing else.
 */
export function microsoftDeltaToken(link: unknown, driveId: string): string | undefined {
  if (typeof link !== "string" || link.length > 10_000) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(MICROSOFT_GRAPH).origin || url.username || url.password || url.hash) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (path.toLowerCase() !== `/v1.0/drives/${driveId}/root/delta`.toLowerCase()) return undefined;
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== "token" && k !== "$select") || keys.filter((k) => k === "token").length !== 1) return undefined;
  const token = url.searchParams.get("token")!;
  return MICROSOFT_DELTA_TOKEN.test(token) ? token : undefined;
}

export function microsoftClient(options: MicrosoftClientOptions): MicrosoftClient {
  const tenant = microsoftGuid(options.tenantId);
  const clientId = microsoftGuid(options.clientId);
  const secret = options.clientSecret?.trim() ?? "";
  if (!tenant) throw new MicrosoftConfigError("MICROSOFT_TENANT_ID is missing or not a directory (tenant) id");
  if (!clientId) throw new MicrosoftConfigError("MICROSOFT_CLIENT_ID is missing or not an application (client) id");
  if (!/^[\x21-\x7e]{16,256}$/.test(secret)) throw new MicrosoftConfigError("MICROSOFT_CLIENT_SECRET is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const now = options.now ?? (() => new Date());
  let token: { value: string; until: number } | null = null;

  async function signIn(): Promise<string> {
    if (token && now().getTime() < token.until) return token.value;
    const body = new URLSearchParams({ client_id: clientId!, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
    const response = await fetch(`${MICROSOFT_LOGIN}/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const reply: unknown = await response.json().catch(() => undefined);
    if (response.status !== 200) {
      const codes = isObject(reply) && Array.isArray(reply.error_codes) ? reply.error_codes : [];
      if (codes.includes(7000215) || codes.includes(7000222)) throw new MicrosoftConfigError("Microsoft turned down MICROSOFT_CLIENT_SECRET: it may have expired or been deleted. Add a new client secret to the app and save it");
      if (codes.includes(700016)) throw new MicrosoftConfigError("Microsoft has no app with MICROSOFT_CLIENT_ID in this tenant");
      if (codes.includes(90002) || codes.includes(900023)) throw new MicrosoftConfigError("Microsoft has no tenant with MICROSOFT_TENANT_ID");
      throw new MicrosoftApiError(`Microsoft answered HTTP ${response.status} to the sign-in`, response.status);
    }
    if (!isObject(reply) || typeof reply.access_token !== "string" || !ACCESS_TOKEN.test(reply.access_token)) throw new MicrosoftApiError("Microsoft's sign-in had no access token in the expected shape", 200);
    // A token that says it can do more than read is never used.
    const roles = microsoftTokenRoles(reply.access_token);
    const extra = roles?.filter((r) => !(MICROSOFT_READ_ROLES as readonly string[]).includes(r)) ?? [];
    if (extra.length > 0) throw new MicrosoftConfigError(`the app has ${extra.slice(0, 5).join(", ")}; KaratOS only reads, so give it Sites.Selected with the read role and nothing else`);
    const seconds = Number.isFinite(reply.expires_in) ? (reply.expires_in as number) : 0;
    token = { value: reply.access_token, until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  }

  async function get(url: URL, what: string): Promise<Record<string, unknown>> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${await signIn()}`, Accept: "application/json" } });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        attempt--;
        continue;
      }
      if ((response.status === 429 || response.status === 503) && attempt < retries) {
        const wait = retryAfter(response.headers.get("retry-after"));
        await sleep(1000 * (wait !== undefined ? Math.min(Math.max(wait, 1), MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      const reply: unknown = await response.json().catch(() => undefined);
      const raw = isObject(reply) && isObject(reply.error) ? reply.error.code : undefined;
      const code = typeof raw === "string" && /^[A-Za-z]{1,80}$/.test(raw) ? raw : undefined;
      if (response.status === 200) {
        if (!isObject(reply)) throw new MicrosoftApiError(`Microsoft Graph answered ${what} with a body that isn't a JSON object`, 200);
        return reply;
      }
      if (response.status === 410) throw new MicrosoftResyncError(code);
      if (response.status === 401) throw new MicrosoftApiError("Microsoft Graph turned down the app's token twice", 401, code);
      if (response.status === 403) throw new MicrosoftApiError(`the app isn't allowed to read ${what}: grant it the read role on the site or library`, 403, code);
      if (response.status === 404) throw new MicrosoftApiError(`Microsoft Graph couldn't find ${what}: check MICROSOFT_ONEDRIVE_DRIVE_ID`, 404, code);
      throw new MicrosoftApiError(`Microsoft Graph answered HTTP ${response.status} for ${what}`, response.status, code);
    }
  }

  return {
    async delta(driveId, deltaToken) {
      if (!MICROSOFT_DRIVE_ID.test(driveId)) throw new MicrosoftConfigError("MICROSOFT_ONEDRIVE_DRIVE_ID is not a drive id");
      if (deltaToken !== null && !MICROSOFT_DELTA_TOKEN.test(deltaToken)) throw new MicrosoftApiError("the delta token isn't in the expected shape", 0);
      const url = new URL(`${MICROSOFT_GRAPH}/drives/${driveId}/root/delta`);
      if (deltaToken !== null) url.searchParams.set("token", deltaToken);
      url.searchParams.set("$select", MICROSOFT_DELTA_SELECT);
      const reply = await get(url, "the drive");
      if (!Array.isArray(reply.value)) throw new MicrosoftApiError("Microsoft Graph answered the drive without the value list", 200);
      const nextLink = reply["@odata.nextLink"];
      const deltaLink = reply["@odata.deltaLink"];
      if ((nextLink === undefined) === (deltaLink === undefined)) throw new MicrosoftApiError("Microsoft Graph's page of the drive has neither or both of its next and delta links", 200);
      const next = nextLink === undefined ? null : microsoftDeltaToken(nextLink, driveId);
      const delta = deltaLink === undefined ? null : microsoftDeltaToken(deltaLink, driveId);
      if (next === undefined || delta === undefined) throw new MicrosoftApiError("Microsoft Graph sent a paging link that isn't this drive's delta", 200);
      return { items: (reply.value as unknown[]).filter(isObject), next, delta };
    },
  };
}
