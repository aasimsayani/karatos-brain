import { GOOGLE_IDENTITY_SCOPES, GOOGLE_TOKEN_URL, googleMatches, type GoogleWorkspaceTokenStore } from "../google_workspace/client.js";

/**
 * A small client for the Google Analytics Data API (v1beta). Read-only three
 * ways over: the connection holds analytics.readonly and nothing else, which
 * the client checks on every new access token; the only request it sends to
 * the API is runReport for the one property in the settings, with a body it
 * builds itself from two fixed reports; and its only other request is the
 * OAuth token refresh. runReport is a POST, but it reads: the Data API has
 * nothing that changes a property, and the Admin API is never called.
 *
 * GA4 reports are aggregates (sessions, users, item views by day and
 * channel), so nothing here names a visitor. Source, medium and item names
 * are cut short, and any that holds an @ is dropped, in case a campaign tag
 * carried an email address.
 *
 * It shares the instance's Google OAuth client (GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET) with Gmail and Google Workspace, and holds its own
 * refresh token, since each connection must hold its own scopes only.
 */

export const GA4_DATA_API_URL = "https://analyticsdata.googleapis.com/v1beta";
/** Reads reports and settings; can't change them. */
export const ANALYTICS_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** Rows asked for per page. The API returns at most 250,000; 10,000 is its default. */
export const GA4_PAGE_SIZE = 10_000;
/** Longest date range one request covers, so a page stays small and a resumed sync repeats little. */
export const GA4_MAX_RANGE_DAYS = 31;

/**
 * The two reports the connector reads, and nothing else. `date` comes first
 * in each, and every dimension is sorted on, so paging by offset keeps a
 * stable order.
 */
export const GA4_REPORTS = {
  traffic: {
    dimensions: ["date", "sessionDefaultChannelGroup", "sessionSourceMedium"],
    metrics: ["sessions", "totalUsers", "newUsers", "engagedSessions", "keyEvents", "ecommercePurchases", "totalRevenue"],
  },
  products: {
    dimensions: ["date", "itemId", "itemName"],
    metrics: ["itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"],
  },
} as const;
export type Ga4Report = keyof typeof GA4_REPORTS;

export interface Ga4ReportQuery {
  report: Ga4Report;
  /** First day, YYYY-MM-DD, in the property's time zone. */
  startDate: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  endDate: string;
  offset: number;
}

export interface GoogleAnalyticsClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: GoogleWorkspaceTokenStore;
  /** The GA4 property's numeric id (GOOGLE_ANALYTICS_PROPERTY_ID). */
  propertyId: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class GoogleAnalyticsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAnalyticsConfigError";
  }
}

/** Google answered with an error. `reason` is its status or error code, when it gives one. */
export class GoogleAnalyticsApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "GoogleAnalyticsApiError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GoogleAnalyticsClient {
  readonly propertyId: string;
  /** One page of one of the fixed reports. */
  runReport(query: Ga4ReportQuery): Promise<Record<string, unknown>>;
}

/** A GA4 property id: digits only, as shown under Admin > Property details. */
export const GA4_PROPERTY_ID = /^[0-9]{1,20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_RETRY_AFTER_S = 64;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function ga4DayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/**
 * The runReport body for one page, or a GoogleAnalyticsConfigError before
 * anything is sent. This is the allowlist: one of the two fixed reports,
 * a checked date range of at most GA4_MAX_RANGE_DAYS and a whole-number
 * offset. No filters, no other dimensions or metrics.
 */
export function ga4ReportBody(query: Ga4ReportQuery): Record<string, unknown> {
  const extra = Object.keys(query ?? {}).filter((k) => !["report", "startDate", "endDate", "offset"].includes(k));
  if (extra.length) throw new GoogleAnalyticsConfigError(`runReport doesn't take ${extra.slice(0, 3).join(", ")}`);
  if (typeof query.report !== "string" || !Object.hasOwn(GA4_REPORTS, query.report)) throw new GoogleAnalyticsConfigError("the Google Analytics connector only reads its two listed reports");
  const start = ga4DayMs(query.startDate);
  const end = ga4DayMs(query.endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new GoogleAnalyticsConfigError("startDate and endDate must be days as YYYY-MM-DD");
  if (end < start || (end - start) / DAY_MS + 1 > GA4_MAX_RANGE_DAYS) throw new GoogleAnalyticsConfigError(`a report covers 1 to ${GA4_MAX_RANGE_DAYS} days`);
  if (!Number.isInteger(query.offset) || query.offset < 0) throw new GoogleAnalyticsConfigError("offset must be a whole number from 0");
  const { dimensions, metrics } = GA4_REPORTS[query.report];
  return {
    dateRanges: [{ startDate: query.startDate, endDate: query.endDate }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    orderBys: dimensions.map((dimensionName) => ({ dimension: { dimensionName } })),
    limit: String(GA4_PAGE_SIZE),
    offset: String(query.offset),
    keepEmptyRows: false,
  };
}

/**
 * What's wrong with the scopes a token was granted, or null when it holds
 * analytics.readonly and, at most, the sign-in scopes. analytics (which can
 * change settings), analytics.edit, analytics.manage.users and any other
 * Google scope are a problem, as is a token that doesn't say what it holds.
 */
export function googleAnalyticsScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "Google didn't say which scopes the token holds";
  const scopes = scope.slice(0, 4096).split(" ").filter(Boolean);
  const known = [ANALYTICS_READONLY_SCOPE, ...GOOGLE_IDENTITY_SCOPES] as readonly string[];
  const extra = scopes.filter((s) => !known.includes(s));
  if (extra.length) return `the Google Analytics connection holds more than read-only access (${extra.slice(0, 5).join(", ")})`;
  if (!scopes.includes(ANALYTICS_READONLY_SCOPE)) return `the Google Analytics connection doesn't hold ${ANALYTICS_READONLY_SCOPE}`;
  return null;
}

/** Google's error status and message, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { reason?: string; message: string } {
  const e = ((body ?? {}) as { error?: unknown }).error;
  if (typeof e === "string") return { reason: e.slice(0, 40), message: "" };
  const o = (e ?? {}) as { message?: unknown; status?: unknown };
  return { ...(typeof o.status === "string" ? { reason: o.status.slice(0, 40) } : {}), message: typeof o.message === "string" ? o.message.slice(0, 200) : "" };
}

export function googleAnalyticsClient(options: GoogleAnalyticsClientOptions): GoogleAnalyticsClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new GoogleAnalyticsConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const propertyId = options.propertyId?.trim() ?? "";
  if (!googleMatches(GA4_PROPERTY_ID, propertyId)) throw new GoogleAnalyticsConfigError("GOOGLE_ANALYTICS_PROPERTY_ID must be the property's numeric id");
  const url = `${GA4_DATA_API_URL}/properties/${propertyId}:runReport`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new GoogleAnalyticsConfigError("set GOOGLE_ANALYTICS_REFRESH_TOKEN");
    const response = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint = code === "invalid_grant" ? "; reconnect Google Analytics to get a new refresh token (tokens from a consent screen in Testing last 7 days)" : "";
      throw new GoogleAnalyticsApiError(`Google turned down the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status, code);
    }
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const problem = googleAnalyticsScopeProblem(body.scope);
    if (problem) throw new GoogleAnalyticsConfigError(`${problem}; reconnect it with only ${ANALYTICS_READONLY_SCOPE}`);
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

  return {
    propertyId,
    async runReport(query) {
      const body = JSON.stringify(ga4ReportBody(query));
      let renewed = false;
      for (let attempt = 0; ; ) {
        // runReport only, for the one property, with the token in the Authorization header and never in the URL.
        const response = await doFetch(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${await accessToken()}` },
          body,
        });
        if (response.status === 401 && !renewed) {
          renewed = true;
          access = null;
          continue;
        }
        const answer: unknown = await response.json().catch(() => null);
        const { reason, message } = errorOf(answer);
        if (response.status === 429) {
          if (attempt < retries) {
            const after = Number(response.headers.get("retry-after"));
            await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : Math.min(1000 * 2 ** attempt, MAX_RETRY_AFTER_S * 1000));
            attempt++;
            continue;
          }
          throw new GoogleAnalyticsApiError("Google Analytics kept rate-limiting the sync; its quota refills hourly and daily, and the next sync resumes from the checkpoint", 429, reason);
        }
        if (!response.ok) {
          const hint = response.status === 403 ? `; the connected Google account needs Viewer access to property ${propertyId}` : "";
          throw new GoogleAnalyticsApiError(`Google Analytics answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status, reason);
        }
        if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new GoogleAnalyticsApiError("Google Analytics did not answer with JSON", response.status);
        return answer as Record<string, unknown>;
      }
    },
  };
}
