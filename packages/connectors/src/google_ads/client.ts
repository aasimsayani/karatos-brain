import { GOOGLE_IDENTITY_SCOPES, GOOGLE_TOKEN_URL, googleMatches, type GoogleWorkspaceTokenStore } from "../google_workspace/client.js";

/**
 * A small client for the Google Ads API (REST, v26). Google offers one scope
 * for the API, adwords, and it can change campaigns, so the scope alone
 * can't keep the connection read-only. The client does instead: the only
 * request it sends to the API is googleAds:search for the one account in the
 * settings, with a query it builds itself from one fixed report, and its
 * only other request is the OAuth token refresh. It never calls a mutate
 * method. The setup guide asks for a Google Ads user with Read only access,
 * so Google itself would turn down a change if one were ever sent.
 *
 * The report is campaign figures by day (impressions, clicks, cost,
 * conversions), so nothing here names a person. Campaign names are cut
 * short, and one holding an @ is dropped.
 *
 * It shares the instance's Google OAuth client (GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET) with Gmail, Google Workspace and Google Analytics,
 * and holds its own refresh token, since each connection holds its own
 * scopes only.
 */

export const GOOGLE_ADS_API_URL = "https://googleads.googleapis.com/v26";
/** The Google Ads API's only scope. It can read and change an account; the client only reads. */
export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";

/** Longest date range one query covers, so a page stays small and a resumed sync repeats little. */
export const GOOGLE_ADS_MAX_RANGE_DAYS = 31;

/** The one report the connector reads: each campaign's figures by day, with the account's currency and time zone. */
export const GOOGLE_ADS_FIELDS = [
  "customer.currency_code",
  "customer.time_zone",
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.advertising_channel_type",
  "campaign_budget.amount_micros",
  "segments.date",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
] as const;

export interface GoogleAdsQuery {
  /** First day, YYYY-MM-DD, in the account's time zone. */
  startDate: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  endDate: string;
  /** The nextPageToken of the previous page of the same query; null for the first page. */
  pageToken: string | null;
}

export interface GoogleAdsClientOptions {
  clientId: string;
  clientSecret: string;
  tokens: GoogleWorkspaceTokenStore;
  /** The developer token from the manager account's API Center (GOOGLE_ADS_DEVELOPER_TOKEN). */
  developerToken: string;
  /** The account read, 10 digits (GOOGLE_ADS_CUSTOMER_ID). */
  customerId: string;
  /** The manager account the user reaches it through, when there is one (GOOGLE_ADS_LOGIN_CUSTOMER_ID). */
  loginCustomerId?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

export class GoogleAdsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAdsConfigError";
  }
}

/** Google answered with an error. `reason` is its Google Ads error code or status, when it gives one. */
export class GoogleAdsApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "GoogleAdsApiError";
    this.status = status;
    this.reason = reason;
  }
}

export interface GoogleAdsClient {
  readonly customerId: string;
  /** One page of the fixed report. */
  search(query: GoogleAdsQuery): Promise<Record<string, unknown>>;
}

/** A customer id: 10 digits, with or without the dashes Google Ads shows. */
const CUSTOMER_ID = /^\d{3}-?\d{3}-?\d{4}$/;
/** A developer token: printable, no spaces, as it goes in a header. */
const DEVELOPER_TOKEN = /^[\x21-\x7e]{1,200}$/;
/** A page token as Google returns it. */
const PAGE_TOKEN = /^[A-Za-z0-9_=+/-]{1,2048}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const ACCESS_RENEW_EARLY_MS = 2 * 60_000;
const MAX_RETRY_AFTER_S = 64;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function googleAdsDayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/** A customer id as the API takes it, digits only, or undefined when it isn't one. */
export function googleAdsCustomerId(value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  return googleMatches(CUSTOMER_ID, t) ? t.replaceAll("-", "") : undefined;
}

/**
 * The googleAds:search body for one page, or a GoogleAdsConfigError before
 * anything is sent. This is the allowlist: the fixed report's fields from
 * campaign, a checked date range of at most GOOGLE_ADS_MAX_RANGE_DAYS and a
 * page token Google returned. Nothing of the caller's goes into the query
 * but two checked days.
 */
export function googleAdsSearchBody(query: GoogleAdsQuery): { query: string; pageToken?: string } {
  const extra = Object.keys(query ?? {}).filter((k) => !["startDate", "endDate", "pageToken"].includes(k));
  if (extra.length) throw new GoogleAdsConfigError(`search doesn't take ${extra.slice(0, 3).join(", ")}`);
  const start = googleAdsDayMs(query.startDate);
  const end = googleAdsDayMs(query.endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new GoogleAdsConfigError("startDate and endDate must be days as YYYY-MM-DD");
  if (end < start || (end - start) / DAY_MS + 1 > GOOGLE_ADS_MAX_RANGE_DAYS) throw new GoogleAdsConfigError(`a report covers 1 to ${GOOGLE_ADS_MAX_RANGE_DAYS} days`);
  if (query.pageToken !== null && !googleMatches(PAGE_TOKEN, query.pageToken)) throw new GoogleAdsConfigError("pageToken must be the token Google returned");
  const gaql = `SELECT ${GOOGLE_ADS_FIELDS.join(", ")} FROM campaign WHERE segments.date BETWEEN '${query.startDate}' AND '${query.endDate}' ORDER BY segments.date, campaign.id`;
  return query.pageToken === null ? { query: gaql } : { query: gaql, pageToken: query.pageToken };
}

/**
 * What's wrong with the scopes a token was granted, or null when it holds
 * adwords and, at most, the sign-in scopes. Any other Google scope is a
 * problem, as is a token that doesn't say what it holds.
 */
export function googleAdsScopeProblem(scope: unknown): string | null {
  if (typeof scope !== "string" || !scope.trim()) return "Google didn't say which scopes the token holds";
  const scopes = scope.slice(0, 4096).split(" ").filter(Boolean);
  const known = [ADWORDS_SCOPE, ...GOOGLE_IDENTITY_SCOPES] as readonly string[];
  const extra = scopes.filter((s) => !known.includes(s));
  if (extra.length) return `the Google Ads connection holds more than the Google Ads scope (${extra.slice(0, 5).join(", ")})`;
  if (!scopes.includes(ADWORDS_SCOPE)) return `the Google Ads connection doesn't hold ${ADWORDS_SCOPE}`;
  return null;
}

/**
 * Google's error code and message, cut short. A Google Ads failure names its
 * own code (such as DEVELOPER_TOKEN_NOT_APPROVED) inside details; otherwise
 * the status is the reason. Error bodies describe the request, never the token.
 */
function errorOf(body: unknown): { reason?: string; message: string } {
  const e = ((body ?? {}) as { error?: unknown }).error;
  if (typeof e === "string") return { reason: e.slice(0, 40), message: "" };
  const o = (e ?? {}) as { message?: unknown; status?: unknown; details?: unknown };
  const failure = Array.isArray(o.details) ? (o.details[0] as { errors?: unknown } | undefined) : undefined;
  const first = Array.isArray(failure?.errors) ? (failure.errors[0] as { errorCode?: unknown; message?: unknown } | undefined) : undefined;
  const code = first?.errorCode && typeof first.errorCode === "object" ? Object.values(first.errorCode as Record<string, unknown>)[0] : undefined;
  const reason = typeof code === "string" ? code : typeof o.status === "string" ? o.status : undefined;
  const message = typeof first?.message === "string" ? first.message : typeof o.message === "string" ? o.message : "";
  return { ...(reason ? { reason: reason.slice(0, 40) } : {}), message: message.slice(0, 200) };
}

function hintFor(status: number, reason: string | undefined, customerId: string): string {
  if (reason === "DEVELOPER_TOKEN_NOT_APPROVED") return "; a developer token with test access reads test accounts only, so apply for Basic access in the API Center";
  if (status === 403) return `; the connected Google account needs access to account ${customerId}, or set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account it reaches it through`;
  return "";
}

export function googleAdsClient(options: GoogleAdsClientOptions): GoogleAdsClient {
  const clientId = options.clientId?.trim() ?? "";
  const clientSecret = options.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new GoogleAdsConfigError("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const developerToken = options.developerToken?.trim() ?? "";
  if (!googleMatches(DEVELOPER_TOKEN, developerToken)) throw new GoogleAdsConfigError("set GOOGLE_ADS_DEVELOPER_TOKEN");
  const customerId = googleAdsCustomerId(options.customerId);
  if (!customerId) throw new GoogleAdsConfigError("GOOGLE_ADS_CUSTOMER_ID must be the account's 10-digit customer id");
  const login = options.loginCustomerId?.trim() ? googleAdsCustomerId(options.loginCustomerId) : null;
  if (login === undefined) throw new GoogleAdsConfigError("GOOGLE_ADS_LOGIN_CUSTOMER_ID must be the manager account's 10-digit customer id");
  const url = `${GOOGLE_ADS_API_URL}/customers/${customerId}/googleAds:search`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const clock = options.clock ?? (() => Date.now());
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const refreshToken = (await options.tokens.load()).trim();
    if (!refreshToken) throw new GoogleAdsConfigError("set GOOGLE_ADS_REFRESH_TOKEN");
    const response = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown };
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
      const code = typeof body.error === "string" ? body.error.slice(0, 40) : undefined;
      const hint = code === "invalid_grant" ? "; reconnect Google Ads to get a new refresh token (tokens from a consent screen in Testing last 7 days)" : "";
      throw new GoogleAdsApiError(`Google turned down the token refresh (HTTP ${response.status}${code ? `, ${code}` : ""})${hint}`, response.status, code);
    }
    if (typeof body.refresh_token === "string" && body.refresh_token) await options.tokens.save(body.refresh_token);
    const problem = googleAdsScopeProblem(body.scope);
    if (problem) throw new GoogleAdsConfigError(`${problem}; reconnect it with only ${ADWORDS_SCOPE}`);
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
    customerId,
    async search(query) {
      const body = JSON.stringify(googleAdsSearchBody(query));
      let renewed = false;
      for (let attempt = 0; ; ) {
        // googleAds:search only, for the one account, with the tokens in headers and never in the URL.
        const response = await doFetch(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${await accessToken()}`,
            "developer-token": developerToken,
            ...(login ? { "login-customer-id": login } : {}),
          },
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
          throw new GoogleAdsApiError("Google Ads kept rate-limiting the sync; its daily operations quota refills each day, and the next sync resumes from the checkpoint", 429, reason);
        }
        if (!response.ok) {
          throw new GoogleAdsApiError(`Google Ads answered HTTP ${response.status}${message ? `: ${message}` : ""}${hintFor(response.status, reason, customerId)}`, response.status, reason);
        }
        if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new GoogleAdsApiError("Google Ads did not answer with JSON", response.status);
        return answer as Record<string, unknown>;
      }
    },
  };
}
