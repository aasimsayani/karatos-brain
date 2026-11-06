/**
 * A small client for Meta's Marketing API (Graph API v26.0), for one ad
 * account's campaign insights. Read-only three ways over: the token must
 * hold ads_read and no permission that can change anything (ads_management,
 * business_management and the like), which the client checks against
 * /me/permissions before its first read; the only other request it sends is
 * the insights read for the one ad account in the settings, with
 * parameters it builds itself from one fixed report; and it never follows a
 * URL Meta returns, rebuilding each next page from the cursor instead.
 *
 * Insights are campaign totals by day (spend, impressions, reach, clicks,
 * purchases), so nothing here names a person. Campaign names are cut short,
 * and one holding an @ is dropped.
 *
 * The token goes in the Authorization header, never in a URL.
 */

export const META_GRAPH_URL = "https://graph.facebook.com/v26.0";
/** Reads ads and their insights; can't change them. */
export const META_ADS_READ_PERMISSION = "ads_read";
/** Granted alongside any token and harmless: the app-scoped user id and name. */
export const META_BASE_PERMISSIONS = ["public_profile"] as const;

/** Longest date range one read covers, so a page stays small and a resumed sync repeats little. */
export const META_ADS_MAX_RANGE_DAYS = 31;
/** Rows asked for per page. */
export const META_ADS_PAGE_SIZE = 500;

/** The one report the connector reads: each campaign's figures by day. */
export const META_ADS_FIELDS = [
  "campaign_id",
  "campaign_name",
  "objective",
  "account_currency",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "actions",
  "action_values",
  "date_start",
  "date_stop",
] as const;

export interface MetaAdsQuery {
  /** First day, YYYY-MM-DD, in the ad account's time zone. */
  since: string;
  /** Last day, YYYY-MM-DD, inclusive. */
  until: string;
  /** The `after` cursor of the previous page of the same read; null for the first page. */
  after: string | null;
}

export interface MetaAdsClientOptions {
  /** A system user's access token with ads_read only (META_ADS_ACCESS_TOKEN). */
  accessToken: string;
  /** The ad account read, digits, with or without act_ (META_ADS_ACCOUNT_ID). */
  accountId: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate-limited request is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class MetaAdsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaAdsConfigError";
  }
}

/** Meta answered with an error. `code` is its Graph error code, when it gives one. */
export class MetaAdsApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = "MetaAdsApiError";
    this.status = status;
    this.code = code;
  }
}

export interface MetaAdsClient {
  readonly accountId: string;
  /** One page of the fixed report. */
  insights(query: MetaAdsQuery): Promise<Record<string, unknown>>;
}

const ACCOUNT_ID = /^(?:act_)?(\d{1,20})$/;
const TOKEN = /^[A-Za-z0-9_.-]{20,1024}$/;
/** A paging cursor as Meta returns it. */
const CURSOR = /^[A-Za-z0-9_=+/-]{1,1024}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_WAIT_MS = 64_000;
/** Graph error codes for throttling: app, user, page and ad account limits. */
export const META_RATE_LIMIT_CODES: readonly number[] = [4, 17, 32, 613, 80000, 80004];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A YYYY-MM-DD day as epoch milliseconds, or NaN when it isn't a real day. */
export function metaAdsDayMs(value: unknown): number {
  if (typeof value !== "string" || !DAY.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : Number.NaN;
}

/** An ad account id as digits, or undefined when it isn't one. */
export function metaAdsAccountId(value: unknown): string | undefined {
  const t = typeof value === "string" ? value.trim() : "";
  return ACCOUNT_ID.exec(t)?.[1];
}

/**
 * The query string for one page of insights, or a MetaAdsConfigError before
 * anything is sent. This is the allowlist: the fixed fields at campaign
 * level by day, a checked date range of at most META_ADS_MAX_RANGE_DAYS and
 * a cursor Meta returned.
 */
export function metaAdsInsightsParams(query: MetaAdsQuery): URLSearchParams {
  const extra = Object.keys(query ?? {}).filter((k) => !["since", "until", "after"].includes(k));
  if (extra.length) throw new MetaAdsConfigError(`insights doesn't take ${extra.slice(0, 3).join(", ")}`);
  const start = metaAdsDayMs(query.since);
  const end = metaAdsDayMs(query.until);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new MetaAdsConfigError("since and until must be days as YYYY-MM-DD");
  if (end < start || (end - start) / DAY_MS + 1 > META_ADS_MAX_RANGE_DAYS) throw new MetaAdsConfigError(`a report covers 1 to ${META_ADS_MAX_RANGE_DAYS} days`);
  if (query.after !== null && !(typeof query.after === "string" && CURSOR.test(query.after))) throw new MetaAdsConfigError("after must be the cursor Meta returned");
  const params = new URLSearchParams({
    level: "campaign",
    fields: META_ADS_FIELDS.join(","),
    time_range: JSON.stringify({ since: query.since, until: query.until }),
    time_increment: "1",
    limit: String(META_ADS_PAGE_SIZE),
  });
  if (query.after !== null) params.set("after", query.after);
  return params;
}

/**
 * What's wrong with the permissions a token holds, from /me/permissions, or
 * null when it holds ads_read and, at most, public_profile. Any other
 * granted permission is a problem, ads_management above all, as is an
 * answer that doesn't list what the token holds.
 */
export function metaAdsPermissionProblem(body: unknown): string | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return "Meta didn't say which permissions the token holds";
  const granted = data
    .filter((p) => (p as { status?: unknown })?.status === "granted")
    .map((p) => (p as { permission?: unknown }).permission)
    .filter((p): p is string => typeof p === "string");
  const known = [META_ADS_READ_PERMISSION, ...META_BASE_PERMISSIONS] as readonly string[];
  const extra = granted.filter((p) => !known.includes(p));
  if (extra.length) return `the Meta Ads token holds more than read-only access (${extra.slice(0, 5).join(", ").slice(0, 200)})`;
  if (!granted.some((p) => p === META_ADS_READ_PERMISSION)) return `the Meta Ads token doesn't hold ${META_ADS_READ_PERMISSION}`;
  return null;
}

/** Meta's error code and message, cut short. Error bodies describe the request, never the token. */
function errorOf(body: unknown): { code?: number; message: string } {
  const e = ((body ?? {}) as { error?: unknown }).error;
  const o = (e && typeof e === "object" ? e : {}) as { message?: unknown; code?: unknown };
  return { ...(typeof o.code === "number" && Number.isInteger(o.code) ? { code: o.code } : {}), message: typeof o.message === "string" ? o.message.slice(0, 200) : "" };
}

export function metaAdsClient(options: MetaAdsClientOptions): MetaAdsClient {
  const token = options.accessToken?.trim() ?? "";
  if (!TOKEN.test(token)) throw new MetaAdsConfigError("set META_ADS_ACCESS_TOKEN");
  const accountId = metaAdsAccountId(options.accountId);
  if (!accountId) throw new MetaAdsConfigError("META_ADS_ACCOUNT_ID must be the ad account's numeric id");
  const insightsUrl = `${META_GRAPH_URL}/act_${accountId}/insights`;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  let checked: Promise<void> | null = null;

  // GET only, with the token in the Authorization header and never in the URL.
  async function get(url: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` } });
      const answer: unknown = await response.json().catch(() => null);
      const { code, message } = errorOf(answer);
      const limited = response.status === 429 || (code !== undefined && META_RATE_LIMIT_CODES.includes(code));
      if (limited) {
        if (attempt < retries) {
          await sleep(Math.min(1000 * 2 ** attempt, MAX_WAIT_MS));
          continue;
        }
        throw new MetaAdsApiError("Meta kept rate-limiting the sync; its limits refill within the hour, and the next sync resumes from the checkpoint", response.status, code);
      }
      if (!response.ok) {
        const hint = code === 190 ? "; the token expired or was revoked, so make a new system user token" : code === 200 || code === 10 ? `; the system user needs the ad account act_${accountId} assigned to it` : "";
        throw new MetaAdsApiError(`Meta answered HTTP ${response.status}${message ? `: ${message}` : ""}${hint}`, response.status, code);
      }
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new MetaAdsApiError("Meta did not answer with JSON", response.status);
      return answer as Record<string, unknown>;
    }
  }

  async function check(): Promise<void> {
    const problem = metaAdsPermissionProblem(await get(`${META_GRAPH_URL}/me/permissions`));
    if (problem) throw new MetaAdsConfigError(`${problem}; make a system user token with only ${META_ADS_READ_PERMISSION}`);
  }

  return {
    accountId,
    async insights(query) {
      const params = metaAdsInsightsParams(query);
      // Checked once per client; a failed check is tried again on the next read.
      checked ??= check().catch((error: unknown) => {
        checked = null;
        throw error;
      });
      await checked;
      return get(`${insightsUrl}?${params}`);
    },
  };
}
