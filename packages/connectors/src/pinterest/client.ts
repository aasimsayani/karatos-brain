import type { QuickBooksTokenStore } from "../quickbooks/client.js";

/**
 * A small client for Pinterest's API (v5), for one business account's Pins
 * and analytics. Read-only two ways over: the connection holds the read
 * scopes boards:read, pins:read and user_accounts:read and nothing else,
 * which the client checks on every token refresh before reading anything;
 * and the only requests it sends are the Pin list and two analytics reads
 * for the connected account, with parameters it builds and checks itself.
 *
 * Pins are the store's own posts, and analytics are totals by day or by
 * Pin, so nothing here names a customer. Pin descriptions aren't kept, and
 * a link keeps its address without the query string.
 *
 * The app's id and secret go in a Basic header to the token endpoint, and
 * the access token in a Bearer header, never in a URL.
 */

export const PINTEREST_API_URL = "https://api.pinterest.com/v5";
/** The scopes the connection may hold: every one reads, none writes. */
export const PINTEREST_READ_SCOPES = ["boards:read", "pins:read", "user_accounts:read"] as const;

/** Pinterest's analytics reach back this many days, today included. */
export const PINTEREST_ANALYTICS_DAYS = 90;
/** Pins asked for per page; Pinterest's most. */
export const PINTEREST_PAGE_SIZE = 250;
/** The most Pins the top Pins report ranks. */
export const PINTEREST_TOP_PINS = 50;
/** The account metrics read, by day and for the top Pins. */
export const PINTEREST_METRICS = ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK", "ENGAGEMENT"] as const;

export type PinterestTokenStore = QuickBooksTokenStore;

/** A range of days for the analytics reads, both YYYY-MM-DD in UTC. */
export interface PinterestRange {
  startDate: string;
  endDate: string;
}

export interface PinterestClientOptions {
  /** The app's id (PINTEREST_CLIENT_ID). */
  clientId: string;
  /** The app's secret key (PINTEREST_CLIENT_SECRET). */
  clientSecret: string;
  /** Holds the refresh token, which Pinterest replaces on every refresh. */
  tokens: PinterestTokenStore;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class PinterestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinterestConfigError";
  }
}

/** Pinterest answered with an error. `code` is its error code, when it gives one. */
export class PinterestApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "PinterestApiError";
    this.status = status;
    this.code = code;
  }
}

export interface PinterestClient {
  /** One page of the account's Pins, with their metrics. */
  pins(bookmark: string | null): Promise<Record<string, unknown>>;
  /** The account's metrics by day. */
  accountAnalytics(range: PinterestRange): Promise<Record<string, unknown>>;
  /** The account's most saved Pins over the range. */
  topPins(range: PinterestRange): Promise<Record<string, unknown>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A bookmark as Pinterest returns it. */
const BOOKMARK = /^[A-Za-z0-9_=+/-]{1,2048}$/;
/** Printable, no spaces, as each goes in a header. */
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;
const DAY_MS = 86_400_000;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_WAIT_S = 64;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function pinterestDayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/**
 * The query string for an analytics read, or a PinterestConfigError before
 * anything is sent: a checked range of at most PINTEREST_ANALYTICS_DAYS and
 * the fixed metrics, with the top Pins read ranked by saves.
 */
export function pinterestAnalyticsParams(range: PinterestRange, top = false): URLSearchParams {
  const extra = Object.keys(range ?? {}).filter((k) => !["startDate", "endDate"].includes(k));
  if (extra.length) throw new PinterestConfigError(`analytics don't take ${extra.slice(0, 3).join(", ")}`);
  const start = pinterestDayMs(range.startDate);
  const end = pinterestDayMs(range.endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new PinterestConfigError("startDate and endDate must be days as YYYY-MM-DD");
  if (end < start || (end - start) / DAY_MS + 1 > PINTEREST_ANALYTICS_DAYS) throw new PinterestConfigError(`a report covers 1 to ${PINTEREST_ANALYTICS_DAYS} days`);
  const params = new URLSearchParams({ start_date: range.startDate, end_date: range.endDate, metric_types: PINTEREST_METRICS.join(",") });
  if (top) {
    params.set("sort_by", "SAVE");
    params.set("num_of_pins", String(PINTEREST_TOP_PINS));
  }
  return params;
}

/** The query string for a page of Pins, or a PinterestConfigError for a bookmark Pinterest didn't give. */
export function pinterestPinsParams(bookmark: string | null): URLSearchParams {
  if (bookmark !== null && !(typeof bookmark === "string" && BOOKMARK.test(bookmark))) throw new PinterestConfigError("bookmark must be the one Pinterest returned");
  const params = new URLSearchParams({ page_size: String(PINTEREST_PAGE_SIZE), pin_metrics: "true" });
  if (bookmark !== null) params.set("bookmark", bookmark);
  return params;
}

/**
 * What's wrong with the scopes a token holds, or null when it holds every
 * read scope and nothing more. Pinterest lists them separated by commas or
 * spaces. Any other scope is a problem, a write scope above all, as is a
 * token that doesn't say what it holds.
 */
export function pinterestScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "Pinterest didn't say which scopes the token holds";
  const scopes = scope.split(/[\s,]+/).filter(Boolean);
  const known = PINTEREST_READ_SCOPES as readonly string[];
  const extra = scopes.filter((s) => !known.includes(s));
  if (extra.length) return `the Pinterest connection holds more than read access (${extra.slice(0, 5).join(", ").slice(0, 200)})`;
  const lacking = known.filter((s) => !scopes.includes(s));
  if (lacking.length) return `the Pinterest connection doesn't hold ${lacking.join(", ")}`;
  return null;
}

/** Pinterest's error code and message, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { code?: number; message: string } {
  const o = (body && typeof body === "object" ? body : {}) as { code?: unknown; message?: unknown };
  return { ...(typeof o.code === "number" && Number.isInteger(o.code) ? { code: o.code } : {}), message: typeof o.message === "string" ? o.message.slice(0, 200) : "" };
}

export function pinterestClient(options: PinterestClientOptions): PinterestClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!CREDENTIAL.test(clientId) || !CREDENTIAL.test(clientSecret)) throw new PinterestConfigError("set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new PinterestConfigError("set PINTEREST_REFRESH_TOKEN");
    const response = await doFetch(`${PINTEREST_API_URL}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const { code, message } = errorOf(body);
      const hint = response.status === 401 ? "; check PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET" : response.status === 400 ? "; the refresh token expired or was revoked, so connect the Pinterest account again" : "";
      throw new PinterestApiError(`Pinterest turned down the token refresh (HTTP ${response.status}${message ? `: ${message}` : ""})${hint}`, response.status, code);
    }
    // Pinterest's continuous refresh tokens are replaced on every refresh; the old one stops working after a while.
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const problem = pinterestScopeProblem(body.scope);
    if (problem) throw new PinterestConfigError(`${problem}; connect it again with only ${PINTEREST_READ_SCOPES.join(", ")}`);
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

  // GET only, to the three paths the connector reads, with the token in a header and never in the URL.
  async function get(path: "/pins" | "/user_account/analytics" | "/user_account/analytics/top_pins", params: URLSearchParams): Promise<Record<string, unknown>> {
    const url = `${PINTEREST_API_URL}${path}?${params}`;
    let renewed = false;
    for (let attempt = 0; ; ) {
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` } });
      if (response.status === 401 && !renewed) {
        renewed = true;
        access = null;
        continue;
      }
      const answer: unknown = await response.json().catch(() => null);
      const { code, message } = errorOf(answer);
      if (response.status === 429) {
        if (attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : Math.min(1000 * 2 ** attempt, MAX_WAIT_S * 1000));
          attempt++;
          continue;
        }
        throw new PinterestApiError("Pinterest kept rate-limiting the sync; its limits refill within the minute, and the next sync resumes from the checkpoint", 429, code);
      }
      if (!response.ok) {
        const hint = response.status === 403 ? "; analytics need a business account, so convert the Pinterest account to one" : "";
        throw new PinterestApiError(`Pinterest answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status, code);
      }
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new PinterestApiError("Pinterest did not answer with JSON", response.status);
      return answer as Record<string, unknown>;
    }
  }

  return {
    pins: async (bookmark) => get("/pins", pinterestPinsParams(bookmark)),
    accountAnalytics: async (range) => get("/user_account/analytics", pinterestAnalyticsParams(range)),
    topPins: async (range) => get("/user_account/analytics/top_pins", pinterestAnalyticsParams(range, true)),
  };
}
