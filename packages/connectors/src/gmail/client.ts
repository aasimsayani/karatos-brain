import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for the Gmail API. Read-only twice over: the mailbox is
 * connected with the gmail.metadata scope, which can't see message bodies or
 * attachments and can't change anything, and the client checks that on every
 * new access token; and the only requests it sends to the mailbox are GETs
 * from a fixed list, each with parameters it checks. Its one POST is the
 * OAuth token refresh, which goes to Google's token endpoint.
 *
 * A message is always read with format=metadata and the same three address
 * headers, so subjects, bodies and snippets of text never reach the client
 * except the snippet Google sends with every message, which the normalizer
 * drops.
 *
 * Google doesn't rotate refresh tokens, so the one from the host's secret
 * store keeps working until the mailbox owner revokes it, it goes six months
 * unused, the owner changes their password, or (for a consent screen left in
 * Testing) seven days pass. If Google ever does return a new one, it's saved
 * like QuickBooks' and Xero's.
 *
 * Gmail charges quota units per call (messages.get 20, messages.list 5,
 * history.list 2, labels.list 1) against 6,000 units a minute per mailbox.
 * The client paces itself under that budget, waits out 429s and
 * rateLimitExceeded or userRateLimitExceeded 403s, and stops on a daily limit
 * so the sync resumes from its checkpoint.
 */

export const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1";

/** The one data scope: headers and labels, never bodies or attachments. A restricted scope. */
export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
/** Scopes that only say who signed in. Google may add them to a token; they can't touch mail. */
export const GMAIL_IDENTITY_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/userinfo.email"] as const;

/** The only headers ever requested: who sent a message and who it went to. No Subject, Date or anything else. */
export const GMAIL_METADATA_HEADERS = ["From", "To", "Cc"] as const;

/** Gmail's largest page for messages.list and history.list. */
export const GMAIL_PAGE_SIZE = 500;

/** The history kinds the incremental sync reads. */
export const GMAIL_HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;

/** Quota units each read costs, from Gmail's quota page. */
export const GMAIL_QUOTA_UNITS = { "messages.list": 5, "messages.get": 20, "labels.list": 1, "history.list": 2 } as const;
/** Gmail allows 6,000 units a minute per user; the client stays under 5,000 to leave room for the owner's other apps. */
export const GMAIL_UNITS_PER_MINUTE = 5000;

/** The reads the client may send, and nothing else. */
export type GmailRead =
  | { method: "messages.list"; pageToken?: string; maxResults?: number }
  | { method: "messages.get"; id: string; format: "metadata"; metadataHeaders: readonly string[] }
  | { method: "labels.list" }
  | { method: "history.list"; startHistoryId: string; pageToken?: string; maxResults?: number; historyTypes: readonly string[] };
export type GmailMethod = GmailRead["method"];

/** Same shape as QuickBooks': the newest refresh token, kept encrypted by the instance. */
export type GmailTokenStore = QuickBooksTokenStore;

export interface GmailClientOptions {
  clientId: string;
  clientSecret: string;
  /** The mailbox: "me" (the account that connected) or that account's address. */
  userId?: string;
  tokens: GmailTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits for pacing and before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Quota units a minute the client paces itself to. */
  unitsPerMinute?: number;
  /** Milliseconds since the epoch; replaced in tests to expire access tokens. */
  clock?: () => number;
}

export class GmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailConfigError";
  }
}

/** Gmail or Google's token endpoint answered with an error. `reason` is Google's reason code, when it gives one. */
export class GmailApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GmailClient {
  /** One GET from the allowlist. Null when Gmail answers 404: the message is gone, or the history id is too old. */
  read(request: GmailRead): Promise<Record<string, unknown> | null>;
}

const USER = /^(me|[^\s@/?#%]+@[^\s@/?#%]+\.[^\s@/?#%]+)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_.~-]{1,1024}$/;
const HISTORY_ID = /^\d{1,20}$/;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_RETRY_AFTER_S = 60;
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** The keys each read may carry. Anything else, such as q or a different format, is refused. */
const ALLOWED_KEYS: Record<GmailMethod, readonly string[]> = {
  "messages.list": ["method", "pageToken", "maxResults"],
  "messages.get": ["method", "id", "format", "metadataHeaders"],
  "labels.list": ["method"],
  "history.list": ["method", "startHistoryId", "pageToken", "maxResults", "historyTypes"],
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function pageSize(value: unknown, query: URLSearchParams): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > GMAIL_PAGE_SIZE) throw new GmailConfigError(`maxResults must be a whole number from 1 to ${GMAIL_PAGE_SIZE}`);
  query.set("maxResults", String(value));
}

function pageToken(value: unknown, query: URLSearchParams): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !TOKEN.test(value)) throw new GmailConfigError("pageToken must be the token Gmail returned");
  query.set("pageToken", value);
}

/**
 * The URL for one allowed read, or a GmailConfigError before anything is
 * sent. This is the allowlist: four GETs, a fixed format and header list, no
 * search query.
 */
export function gmailReadUrl(userId: string, request: GmailRead): string {
  if (!USER.test(userId)) throw new GmailConfigError('GMAIL_USER must be "me" or the mailbox\'s address');
  const method = (request as { method?: unknown })?.method;
  if (typeof method !== "string" || !Object.hasOwn(ALLOWED_KEYS, method)) throw new GmailConfigError("the Gmail connector only sends its listed reads");
  const extra = Object.keys(request).filter((k) => !ALLOWED_KEYS[method as GmailMethod].includes(k));
  if (extra.length) throw new GmailConfigError(`${method} doesn't take ${extra.slice(0, 3).join(", ")}`);
  const r = request as Record<string, unknown>;
  const query = new URLSearchParams();
  const base = `${GMAIL_API_URL}/users/${encodeURIComponent(userId)}`;
  let path: string;
  switch (method as GmailMethod) {
    case "messages.list":
      pageSize(r.maxResults, query);
      pageToken(r.pageToken, query);
      path = "/messages";
      break;
    case "messages.get": {
      if (typeof r.id !== "string" || !ID.test(r.id)) throw new GmailConfigError("a message id is letters, digits, - and _");
      if (r.format !== "metadata") throw new GmailConfigError("messages are read with format=metadata only");
      if (!Array.isArray(r.metadataHeaders) || !sameList(r.metadataHeaders, GMAIL_METADATA_HEADERS)) {
        throw new GmailConfigError(`messages are read with exactly these headers: ${GMAIL_METADATA_HEADERS.join(", ")}`);
      }
      query.set("format", "metadata");
      for (const header of GMAIL_METADATA_HEADERS) query.append("metadataHeaders", header);
      path = `/messages/${r.id}`;
      break;
    }
    case "labels.list":
      path = "/labels";
      break;
    case "history.list":
      if (typeof r.startHistoryId !== "string" || !HISTORY_ID.test(r.startHistoryId)) throw new GmailConfigError("startHistoryId must be the history id Gmail returned");
      query.set("startHistoryId", r.startHistoryId);
      pageSize(r.maxResults, query);
      pageToken(r.pageToken, query);
      if (!Array.isArray(r.historyTypes) || !r.historyTypes.length || !r.historyTypes.every((t) => (GMAIL_HISTORY_TYPES as readonly unknown[]).includes(t))) {
        throw new GmailConfigError(`historyTypes must be from ${GMAIL_HISTORY_TYPES.join(", ")}`);
      }
      for (const t of r.historyTypes as string[]) query.append("historyTypes", t);
      path = "/history";
      break;
  }
  const qs = query.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

/**
 * What's wrong with the scopes a token was granted, or null when they're
 * exactly what the connector needs: gmail.metadata, plus at most the scopes
 * that only identify the user. Anything that could read bodies (gmail.readonly)
 * or change mail or labels (gmail.modify, gmail.labels, mail.google.com, ...)
 * is a problem, as is a token that doesn't say what it holds.
 */
export function gmailScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "Google didn't say which scopes the token holds";
  const scopes = scope.split(/\s+/).filter(Boolean);
  const extra = scopes.filter((s) => s !== GMAIL_METADATA_SCOPE && !(GMAIL_IDENTITY_SCOPES as readonly string[]).includes(s));
  if (extra.length) return `the Gmail connection holds more than metadata access (${extra.slice(0, 5).join(", ")})`;
  if (!scopes.includes(GMAIL_METADATA_SCOPE)) return "the Gmail connection doesn't hold the gmail.metadata scope";
  return null;
}

/** Google's error reason and message, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { reason?: string; message: string } {
  const e = ((body ?? {}) as { error?: unknown }).error;
  if (typeof e === "string") return { reason: e.slice(0, 40), message: "" };
  const o = (e ?? {}) as { message?: unknown; errors?: { reason?: unknown }[]; status?: unknown };
  const reason = Array.isArray(o.errors) ? o.errors.map((x) => x?.reason).find((r): r is string => typeof r === "string") : undefined;
  return { ...(reason ? { reason: reason.slice(0, 40) } : {}), message: typeof o.message === "string" ? o.message.slice(0, 200) : "" };
}

export function gmailClient(options: GmailClientOptions): GmailClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new GmailConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const userId = options.userId?.trim() || "me";
  if (!USER.test(userId)) throw new GmailConfigError('GMAIL_USER must be "me" or the mailbox\'s address');
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 5;
  const clock = options.clock ?? (() => Date.now());
  const msPerUnit = 60_000 / (options.unitsPerMinute ?? GMAIL_UNITS_PER_MINUTE);
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;
  let nextSlot = 0;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new GmailConfigError("set GMAIL_REFRESH_TOKEN");
    // Google takes the client's credentials in the form body, as its OAuth docs show.
    const response = await doFetch(GMAIL_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      // invalid_grant: revoked, six months unused, a password change, or a Testing-mode token past its seven days.
      const hint = code === "invalid_grant" ? "; reconnect the mailbox to get a new refresh token (tokens from a consent screen in Testing last 7 days)" : "";
      throw new GmailApiError(`Google refused the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status, code);
    }
    // Google doesn't rotate refresh tokens today; if one ever comes back, keep it before anything else.
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const problem = gmailScopeProblem(body.scope);
    if (problem) throw new GmailConfigError(`${problem}; reconnect it with only ${GMAIL_METADATA_SCOPE}`);
    const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    access = { token: body.access_token, expiresAt: clock() + seconds * 1000 };
    return access.token;
  }

  async function accessToken(): Promise<string> {
    if (access && access.expiresAt - ACCESS_RENEW_EARLY_MS > clock()) return access.token;
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** Spaces calls out by their quota cost, so a long import stays under the per-mailbox budget. */
  async function pace(units: number): Promise<void> {
    const now = clock();
    if (nextSlot > now) await sleep(nextSlot - now);
    nextSlot = Math.max(nextSlot, now) + units * msPerUnit;
  }

  return {
    async read(request) {
      const url = gmailReadUrl(userId, request);
      const units = GMAIL_QUOTA_UNITS[request.method];
      let renewed = false;
      for (let attempt = 0; ; ) {
        await pace(units);
        // GET only, with the token in the Authorization header and never in the URL.
        const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` } });
        if (response.status === 401 && !renewed) {
          // An access token can be revoked before it expires; refresh once.
          renewed = true;
          access = null;
          continue;
        }
        if (response.status === 404) return null;
        const body: unknown = await response.json().catch(() => null);
        const { reason, message } = errorOf(body);
        if (response.status === 403 && reason === "dailyLimitExceeded") {
          throw new GmailApiError("Gmail's daily limit for this project is used up; the next sync resumes from the checkpoint", 403, reason);
        }
        if (response.status === 429 || (response.status === 403 && reason && RATE_REASONS.has(reason))) {
          if (attempt < retries) {
            const after = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
            attempt++;
            continue;
          }
          throw new GmailApiError(`Gmail kept rate-limiting the sync${reason ? ` (${reason})` : ""}`, response.status, reason);
        }
        if (!response.ok) {
          const hint = response.status === 403 && reason === "domainPolicy" ? "; the Workspace admin has turned off Gmail access for apps" : "";
          throw new GmailApiError(`Gmail answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status, reason);
        }
        if (!body || typeof body !== "object") throw new GmailApiError("Gmail did not answer with JSON", response.status);
        return body as Record<string, unknown>;
      }
    },
  };
}
