import { GOOGLE_IDENTITY_SCOPES, GOOGLE_TOKEN_URL, type GoogleWorkspaceTokenStore } from "../google_workspace/client.js";

/**
 * A small client for three Google Business Profile APIs: Business
 * Information (the account's locations), My Business v4 (each location's
 * reviews) and Business Profile Performance (each location's daily
 * metrics).
 *
 * Google offers only one scope for these APIs, business.manage, which can
 * also change a profile. So the connection holds business.manage and
 * nothing else, which the client checks on every new access token, and the
 * client only sends GETs to three fixed paths under the one account in the
 * settings, with query strings it builds itself. Its only other request is
 * the OAuth token refresh. Replying to a review is declared behind the
 * write gate and the client has no way to send it.
 *
 * It shares the instance's Google OAuth client (GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET) with the other Google connectors and holds its own
 * refresh token. Google approves Business Profile API access per project on
 * request, so a project without it is turned down with a 403.
 */

export const GBP_INFORMATION_URL = "https://mybusinessbusinessinformation.googleapis.com/v1";
export const GBP_REVIEWS_URL = "https://mybusiness.googleapis.com/v4";
export const GBP_PERFORMANCE_URL = "https://businessprofileperformance.googleapis.com/v1";
/** The only scope the Business Profile APIs take. It can change a profile, so the client sends nothing that does. */
export const BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Locations asked for per page: the most Business Information returns. */
export const GBP_LOCATION_PAGE = 100;
/** Reviews asked for per page: the most My Business returns. */
export const GBP_REVIEW_PAGE = 50;
/** The location fields asked for: never the address, phone or hours. */
export const GBP_LOCATION_FIELDS = "name,title,storeCode";
/** The daily metrics read, in the order they are asked for. */
export const GBP_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "MESSAGING_CLICKS",
  "BUSINESS_BOOKINGS",
] as const;
export type GbpMetric = (typeof GBP_METRICS)[number];

/** An account or location id: digits, as Google writes them after accounts/ or locations/. */
export const GBP_ID = /^[0-9]{1,30}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_.~=+/-]{1,2048}$/;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface GbpClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: GoogleWorkspaceTokenStore;
  /** The Business Profile account's numeric id (GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID). */
  accountId: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class GbpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GbpConfigError";
  }
}

export class GbpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GbpApiError";
  }
}

export interface GbpClient {
  readonly accountId: string;
  /** One page of the account's locations. */
  locations(pageToken: string | null): Promise<Record<string, unknown>>;
  /** One page of a location's reviews, newest change first. */
  reviews(locationId: string, pageToken: string | null): Promise<Record<string, unknown>>;
  /** A location's daily metrics from `from` to `to`, both YYYY-MM-DD and inclusive. */
  metrics(locationId: string, from: string, to: string): Promise<Record<string, unknown>>;
}

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function gbpDayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/**
 * What's wrong with the scopes a token was granted, or null when it holds
 * business.manage and, at most, the sign-in scopes.
 */
export function gbpScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "Google didn't say which scopes the token holds";
  const scopes = scope.split(" ").filter(Boolean);
  const known: readonly string[] = [BUSINESS_MANAGE_SCOPE, ...GOOGLE_IDENTITY_SCOPES];
  const extra = scopes.filter((s) => !known.includes(s));
  if (extra.length > 0) return `the Google Business Profile connection holds more than it needs (${extra.slice(0, 5).join(", ")})`;
  if (!scopes.includes(BUSINESS_MANAGE_SCOPE)) return `the Google Business Profile connection doesn't hold ${BUSINESS_MANAGE_SCOPE}`;
  return null;
}

/** Google's error message, cut short. Error bodies describe the request, never the token. */
const messageOf = (body: unknown) => {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" ? `: ${m.slice(0, 200)}` : "";
};

export function gbpClient(options: GbpClientOptions): GbpClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new GbpConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const accountId = options.accountId?.trim() ?? "";
  if (!GBP_ID.test(accountId)) throw new GbpConfigError("GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID must be the account's numeric id");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const clock = options.clock ?? Date.now;
  let access: { token: string; until: number } | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new GbpConfigError("set GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN");
    const response = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
    if (response.status !== 200 || typeof body.access_token !== "string" || !/^\S{1,4096}$/.test(body.access_token)) {
      const code = typeof body.error === "string" ? `, ${body.error.slice(0, 40)}` : "";
      const hint = body.error === "invalid_grant" ? "; reconnect Google Business Profile to get a new refresh token" : "";
      throw new GbpApiError(`Google turned down the token refresh (HTTP ${response.status}${code})${hint}`, response.status);
    }
    if (typeof body.refresh_token === "string" && body.refresh_token !== "") await options.tokens.save(body.refresh_token);
    const problem = gbpScopeProblem(body.scope);
    if (problem) throw new GbpConfigError(`${problem}; reconnect it with only ${BUSINESS_MANAGE_SCOPE}`);
    const seconds = Number.isSafeInteger(body.expires_in) && (body.expires_in as number) > 0 ? (body.expires_in as number) : 3600;
    access = { token: body.access_token, until: clock() + seconds * 1000 - ACCESS_RENEW_EARLY_MS };
    return access.token;
  }

  async function get(url: string, what: string): Promise<Record<string, unknown>> {
    let renewed = false;
    for (let attempt = 0; ; ) {
      const token = access && clock() < access.until ? access.token : await refresh();
      // GETs only, with the token in the Authorization header and never in the URL.
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` } });
      if (response.status === 401 && !renewed) {
        renewed = true;
        access = null;
        continue;
      }
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        attempt++;
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 403) throw new GbpConfigError(`Google turned down ${what}${messageOf(body)}; the project needs Business Profile API access and the connected account must manage the locations`);
      if (response.status !== 200) throw new GbpApiError(`Google answered HTTP ${response.status} for ${what}${messageOf(body)}`, response.status);
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new GbpApiError(`Google answered ${what} without JSON`, 200);
      return body as Record<string, unknown>;
    }
  }

  const location = (id: string) => {
    if (!GBP_ID.test(id)) throw new GbpApiError("a location id must be digits", 0);
    return id;
  };
  const withPage = (query: URLSearchParams, pageToken: string | null) => {
    if (pageToken !== null && !PAGE_TOKEN.test(pageToken)) throw new GbpApiError("a page token must be one Google gave", 0);
    if (pageToken !== null) query.set("pageToken", pageToken);
    return query;
  };

  return {
    accountId,
    async locations(pageToken) {
      const query = withPage(new URLSearchParams({ readMask: GBP_LOCATION_FIELDS, pageSize: String(GBP_LOCATION_PAGE) }), pageToken);
      return get(`${GBP_INFORMATION_URL}/accounts/${accountId}/locations?${query}`, "the locations");
    },
    async reviews(locationId, pageToken) {
      const query = withPage(new URLSearchParams({ pageSize: String(GBP_REVIEW_PAGE), orderBy: "updateTime desc" }), pageToken);
      return get(`${GBP_REVIEWS_URL}/accounts/${accountId}/locations/${location(locationId)}/reviews?${query}`, "the reviews");
    },
    async metrics(locationId, from, to) {
      const start = gbpDayMs(from);
      const end = gbpDayMs(to);
      if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new GbpApiError("metrics need a from day on or before a to day", 0);
      const query = new URLSearchParams(GBP_METRICS.map((m) => ["dailyMetrics", m]));
      for (const [edge, value] of [["start_date", from], ["end_date", to]] as const) {
        const [year, month, day] = value.split("-").map(Number);
        query.append(`dailyRange.${edge}.year`, String(year));
        query.append(`dailyRange.${edge}.month`, String(month));
        query.append(`dailyRange.${edge}.day`, String(day));
      }
      return get(`${GBP_PERFORMANCE_URL}/locations/${location(locationId)}:fetchMultiDailyMetricsTimeSeries?${query}`, "the metrics");
    },
  };
}
