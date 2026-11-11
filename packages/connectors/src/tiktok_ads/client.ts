/**
 * A small client for TikTok's API for Business (Marketing API v1.3), for
 * one advertiser's campaign report by day. Read-only two ways over: the
 * access token comes from an app made with read scopes only (Ad Account
 * Information and Reporting), and the only request the client sends is a
 * GET of /report/integrated/get/ for the one advertiser in the settings,
 * with parameters it builds itself from one fixed report.
 *
 * The report is campaign totals by day (spend, impressions, reach, clicks,
 * purchases and their value), so nothing here names a person. The token
 * goes in the Access-Token header, never in a URL.
 *
 * TikTok answers most errors with HTTP 200 and a code in the body. Its own
 * message is never put in an error here, only the code. Rate limits (codes
 * 40016, 40100 and 40133, or HTTP 429) and its passing server errors (50000,
 * 51001, 51002, 51004, 51041, 51043 and 60001, or HTTP 5xx) are retried a
 * few times, waiting longer each time, before the error goes to runSync,
 * which keeps the checkpoint.
 */

export const TIKTOK_ADS_HOSTS = {
  production: "https://business-api.tiktok.com/open_api/v1.3",
  sandbox: "https://sandbox-ads.tiktok.com/open_api/v1.3",
} as const;
export type TikTokAdsEnvironment = keyof typeof TIKTOK_ADS_HOSTS;

/** Longest date range one read covers: TikTok reads at most 30 days by day. */
export const TIKTOK_ADS_MAX_RANGE_DAYS = 30;
/** Rows asked for per page, TikTok's most. */
export const TIKTOK_ADS_PAGE_SIZE = 1000;

/** The one report the connector reads: each campaign's figures by day. */
export const TIKTOK_ADS_DIMENSIONS = ["campaign_id", "stat_time_day"] as const;
export const TIKTOK_ADS_METRICS = ["campaign_name", "objective_type", "spend", "impressions", "reach", "clicks", "complete_payment", "total_complete_payment_rate"] as const;

/** Codes TikTok gives when a request is rate-limited. */
export const TIKTOK_ADS_RATE_LIMIT_CODES: readonly number[] = [40016, 40100, 40133];
/** Codes TikTok gives for a passing fault on its side. */
export const TIKTOK_ADS_RETRY_CODES: readonly number[] = [50000, 51001, 51002, 51004, 51041, 51043, 60001];
/** Codes TikTok gives for a token that is missing, expired, revoked or lacks a scope. */
export const TIKTOK_ADS_TOKEN_CODES: readonly number[] = [40001, 40102, 40104, 40105];

export interface TikTokAdsQuery {
  /** First day, YYYY-MM-DD, in the advertiser's time zone. */
  start: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  end: string;
  /** Pages count from 1. */
  page: number;
}

export interface TikTokAdsPage {
  rows: unknown[];
  /** A later page holds more. */
  more: boolean;
}

export interface TikTokAdsClientOptions {
  /** A long-lived advertiser access token from an app with read scopes only (TIKTOK_ADS_ACCESS_TOKEN). */
  accessToken: string;
  /** The advertiser read, digits (TIKTOK_ADS_ADVERTISER_ID). */
  advertiserId: string;
  /** production (the default) or sandbox (TIKTOK_ADS_ENVIRONMENT). */
  environment?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited or failed request is retried here before the error goes to runSync. */
  retries?: number;
}

export class TikTokAdsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokAdsConfigError";
  }
}

/** TikTok answered with an error. `code` is the code in its answer, when it gives one. */
export class TikTokAdsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "TikTokAdsApiError";
  }
}

export interface TikTokAdsClient {
  readonly advertiserId: string;
  readonly baseUrl: string;
  /** One page of the fixed report. */
  report(query: TikTokAdsQuery): Promise<TikTokAdsPage>;
}

const ADVERTISER_ID = /^\d{1,20}$/;
const TOKEN = /^[A-Za-z0-9_.-]{20,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_WAIT_MS = 64_000;

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function tiktokAdsDayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/**
 * The query string for one page of the report, or a TikTokAdsConfigError
 * before anything is sent. This is the allowlist: the fixed report at
 * campaign level by day, for the one advertiser, over a checked range of at
 * most TIKTOK_ADS_MAX_RANGE_DAYS.
 */
export function tiktokAdsReportParams(advertiserId: string, query: TikTokAdsQuery): URLSearchParams {
  const extra = Object.keys(query).filter((k) => !["start", "end", "page"].includes(k));
  if (extra.length) throw new TikTokAdsConfigError(`the report doesn't take ${extra.slice(0, 3).join(", ")}`);
  const start = tiktokAdsDayMs(query.start);
  const end = tiktokAdsDayMs(query.end);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new TikTokAdsConfigError("start and end must be days as YYYY-MM-DD");
  if (end < start || (end - start) / DAY_MS + 1 > TIKTOK_ADS_MAX_RANGE_DAYS) throw new TikTokAdsConfigError(`a report covers 1 to ${TIKTOK_ADS_MAX_RANGE_DAYS} days`);
  if (!Number.isSafeInteger(query.page) || query.page < 1) throw new TikTokAdsConfigError("page must be a whole number, 1 or more");
  return new URLSearchParams({
    advertiser_id: advertiserId,
    service_type: "AUCTION",
    report_type: "BASIC",
    data_level: "AUCTION_CAMPAIGN",
    dimensions: JSON.stringify(TIKTOK_ADS_DIMENSIONS),
    metrics: JSON.stringify(TIKTOK_ADS_METRICS),
    start_date: query.start,
    end_date: query.end,
    query_lifetime: "false",
    page: String(query.page),
    page_size: String(TIKTOK_ADS_PAGE_SIZE),
  });
}

export function tiktokAdsClient(options: TikTokAdsClientOptions): TikTokAdsClient {
  const token = options.accessToken?.trim() ?? "";
  if (!TOKEN.test(token)) throw new TikTokAdsConfigError("TIKTOK_ADS_ACCESS_TOKEN is missing or not in the expected shape");
  const advertiserId = options.advertiserId?.trim() ?? "";
  if (!ADVERTISER_ID.test(advertiserId)) throw new TikTokAdsConfigError("TIKTOK_ADS_ADVERTISER_ID must be the advertiser's numeric ID");
  const environment = options.environment?.trim().toLowerCase() || "production";
  if (environment !== "production" && environment !== "sandbox") throw new TikTokAdsConfigError("TIKTOK_ADS_ENVIRONMENT must be production or sandbox");
  const baseUrl = TIKTOK_ADS_HOSTS[environment];
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    advertiserId,
    baseUrl,
    async report(query) {
      const url = `${baseUrl}/report/integrated/get/?${tiktokAdsReportParams(advertiserId, query)}`;
      for (let attempt = 0; ; attempt++) {
        // GET only, with the token in the Access-Token header and never in the URL.
        const response = await doFetch(url, { method: "GET", headers: { "access-token": token, accept: "application/json" } });
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const code = Number.isSafeInteger(body?.code) ? (body!.code as number) : undefined;
        const limited = response.status === 429 || TIKTOK_ADS_RATE_LIMIT_CODES.includes(code!);
        const passing = response.status >= 500 || TIKTOK_ADS_RETRY_CODES.includes(code!);
        if (limited || passing) {
          if (attempt < retries) {
            await sleep(Math.min(1000 * 2 ** attempt, MAX_WAIT_MS));
            continue;
          }
          const what = limited ? "kept rate-limiting the sync" : "kept failing";
          throw new TikTokAdsApiError(`TikTok ${what}${code === undefined ? ` (HTTP ${response.status})` : ` (code ${code})`}; the next sync resumes from the checkpoint`, response.status, code);
        }
        if (TIKTOK_ADS_TOKEN_CODES.includes(code!)) throw new TikTokAdsConfigError(`TikTok turned down TIKTOK_ADS_ACCESS_TOKEN for advertiser ${advertiserId} (code ${code}); authorize the app again with its read scopes`);
        if (response.status !== 200) throw new TikTokAdsApiError(`TikTok answered HTTP ${response.status} for the report`, response.status, code);
        if (code !== 0) throw new TikTokAdsApiError(code === undefined ? "TikTok answered the report without a code" : `TikTok answered code ${code} for the report`, response.status, code);
        const data = (body!.data ?? {}) as Record<string, unknown>;
        if (!Array.isArray(data.list)) throw new TikTokAdsApiError("TikTok answered the report without a list of rows", response.status, code);
        const info = (data.page_info ?? {}) as Record<string, unknown>;
        // Without page counts that read, the page is the last, so a sync never loops.
        return { rows: data.list, more: Number.isSafeInteger(info.total_page) && (info.total_page as number) > query.page };
      }
    },
  };
}
