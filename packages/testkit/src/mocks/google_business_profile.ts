import { fixtureBuilder, synthetic } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * Google's token refresh and three Google Business Profile APIs: Business
 * Information's location list (v1), My Business's review list (v4) and
 * Business Profile Performance's daily metrics (v1), built from Google's
 * developer docs. Data is synthetic.
 *
 * Docs facts the mock relies on:
 * - `GET /v1/accounts/{account}/locations` needs `readMask`, takes
 *   `pageSize` (1 to 100, default 10) and `pageToken`, and answers
 *   `{locations, nextPageToken}`.
 * - `GET /v4/accounts/{account}/locations/{location}/reviews` takes
 *   `pageSize` (at most 50), `pageToken` and `orderBy` (`rating`,
 *   `rating desc` or `updateTime desc`, the default), and answers
 *   `{reviews, averageRating, totalReviewCount, nextPageToken}`. Each review
 *   has name, reviewId, reviewer, starRating (ONE to FIVE), comment,
 *   createTime, updateTime and reviewReply.
 * - `GET /v1/locations/{location}:fetchMultiDailyMetricsTimeSeries` takes
 *   repeated `dailyMetrics` and `dailyRange.start_date.year` and the like,
 *   and answers `{multiDailyMetricTimeSeries: [{dailyMetricTimeSeries:
 *   [{dailyMetric, timeSeries: {datedValues: [{date, value}]}}]}]}`, with
 *   each value an int64 string, left out when zero.
 * - All three take only the business.manage scope.
 */
const OAUTH = "https://oauth2.googleapis.com";
const INFORMATION = "https://mybusinessbusinessinformation.googleapis.com";
const REVIEWS = "https://mybusiness.googleapis.com";
const PERFORMANCE = "https://businessprofileperformance.googleapis.com";
const REF = "https://developers.google.com/my-business/reference";
export const GBP_DOC_PAGES = {
  oauth: "https://developers.google.com/identity/protocols/oauth2",
  locations: `${REF}/businessinformation/rest/v1/accounts.locations/list`,
  reviews: `${REF}/rest/v4/accounts.locations.reviews/list`,
  review: `${REF}/rest/v4/accounts.locations.reviews`,
  metrics: `${REF}/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries`,
  timeSeries: `${REF}/performance/rest/v1/TimeSeries`,
  dailyMetric: `${REF}/performance/rest/v1/DailyMetric`,
} as const;
export const GBP_TEST_ACCOUNT = "1234567890";
export const GBP_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";
const RATINGS = ["ONE", "TWO", "THREE", "FOUR", "FIVE"];
const METRIC_NAMES = new Set([
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "MESSAGING_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
]);

export type GbpMockRecord = Record<string, unknown>;

/** Location `n` of the test account. */
export const gbpLocation = fixtureBuilder<GbpMockRecord>((n) => ({ name: `locations/${1000 + n}`, title: `Test Jewelers ${n}`, storeCode: `STORE-${n}` }));

/** A review of location 1001, written `n` hours into 2026 and changed then. */
export const gbpReview = fixtureBuilder<GbpMockRecord>((n) => ({
  name: `accounts/${GBP_TEST_ACCOUNT}/locations/1001/reviews/rev-${n}`,
  reviewId: `rev-${n}`,
  reviewer: { profilePhotoUrl: "https://example.test/photo.png", displayName: synthetic.name(n), isAnonymous: false },
  starRating: RATINGS[(n - 1) % 5],
  comment: `Test review ${n}, call me at 555-010-${String(n).padStart(4, "0")}`,
  createTime: synthetic.isoTime(n * 60),
  updateTime: synthetic.isoTime(n * 60),
}));

export interface GbpMockData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId?: string;
  /** Scopes the refreshed token holds. Defaults to business.manage. */
  scopes?: string[];
  locations?: GbpMockRecord[];
  /** Each location's reviews, by location id, in any order: the mock sorts them by updateTime, newest first. */
  reviews?: Record<string, GbpMockRecord[]>;
  /** Each location's metric values, by location id, metric and day (YYYY-MM-DD). */
  metrics?: Record<string, Record<string, Record<string, number>>>;
  /** Locations the account doesn't manage: they answer 403. */
  forbidden?: string[];
  /** 429s to answer before the next API calls. */
  rateLimits?: number;
  /** Rows on a page before a next token, below what the request asks for. */
  pageCap?: number;
}

export interface GbpMock {
  oauth: DocMock;
  information: DocMock;
  reviewsApi: DocMock;
  performance: DocMock;
  fetch: DocMockFetch;
  /** Each API call: what it read and its page token or range. */
  readonly reads: { what: string; location: string | null; page: string | null; range: string | null }[];
  readonly refreshes: number;
  /** Makes every access token handed out so far stop working. */
  revokeTokens(): void;
}

const apiError = (status: number, message: string, headers?: Record<string, string>): DocMockResponse => ({ status, body: { error: { code: status, message, status: status === 429 ? "RESOURCE_EXHAUSTED" : status === 403 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT" } }, ...(headers ? { headers } : {}) });
const dateOf = (q: URLSearchParams, edge: string) => {
  const parts = ["year", "month", "day"].map((k) => q.get(`dailyRange.${edge}.${k}`) ?? "");
  if (!parts.every((v) => /^[0-9]{1,4}$/.test(v))) return null;
  const s = `${parts[0]!.padStart(4, "0")}-${parts[1]!.padStart(2, "0")}-${parts[2]!.padStart(2, "0")}`;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(s) ? s : null;
};

export function gbpDocMock(data: GbpMockData): GbpMock {
  const account = data.accountId ?? GBP_TEST_ACCOUNT;
  const access = new Set<string>();
  const reads: GbpMock["reads"] = [];
  let issued = 0;
  let refreshes = 0;
  let limits = data.rateLimits ?? 0;
  const cap = data.pageCap ?? Number.POSITIVE_INFINITY;

  /** The token and throttle checks every API call shares; null when the call may go on. */
  function gate(request: DocMockRequest): DocMockResponse | null {
    if (!access.has((request.headers.get("authorization") ?? "").slice("Bearer ".length))) return apiError(401, "Request had invalid authentication credentials.");
    if (limits > 0) {
      limits--;
      return apiError(429, "Quota exceeded.", { "retry-after": "1" });
    }
    return null;
  }
  /** A page of `rows` from the offset in `pageToken`. */
  function page(rows: GbpMockRecord[], size: number, token: string | null): { rows: GbpMockRecord[]; next?: string } | null {
    const offset = token === null ? 0 : Number(/^off-([0-9]{1,6})$/.exec(token)?.[1] ?? Number.NaN);
    if (!Number.isSafeInteger(offset)) return null;
    const taken = rows.slice(offset, offset + Math.min(size, cap));
    return { rows: taken, ...(offset + taken.length < rows.length ? { next: `off-${offset + taken.length}` } : {}) };
  }

  const oauth = checkDocMock({
    integration: "google_business_profile",
    baseUrl: OAUTH,
    source: { url: GBP_DOC_PAGES.oauth, title: "Using OAuth 2.0 to Access Google APIs", retrievedOn: "2026-11-11", version: "OAuth 2.0" },
    assumptions: ["A refresh answers access_token, expires_in, scope and token_type, and no new refresh_token", "An expired or revoked refresh token answers 400 invalid_grant"],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: GBP_DOC_PAGES.oauth,
        respond(request) {
          refreshes++;
          const form = new URLSearchParams(request.body);
          if (form.get("client_id") !== data.clientId || form.get("client_secret") !== data.clientSecret) return { status: 401, body: { error: "invalid_client" } };
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
          const token = `AT-GBP-${++issued}`;
          access.add(token);
          return { status: 200, body: { access_token: token, expires_in: 3599, scope: (data.scopes ?? [GBP_MANAGE_SCOPE]).join(" "), token_type: "Bearer" } };
        },
      },
    ],
  });

  const information = checkDocMock({
    integration: "google_business_profile",
    baseUrl: `${INFORMATION}/v1`,
    source: { url: GBP_DOC_PAGES.locations, title: "Business Information API: accounts.locations.list", retrievedOn: "2026-11-11", version: "v1" },
    auth: "bearer",
    assumptions: ["A location's name is locations/ and its numeric id"],
    routes: [
      {
        method: "GET",
        path: "/accounts/{account}/locations",
        documentedAt: GBP_DOC_PAGES.locations,
        respond(request, params) {
          const shut = gate(request);
          if (shut) return shut;
          if (params.account !== account) return apiError(403, "The caller does not have permission");
          const q = request.url.searchParams;
          if ([...q.keys()].some((k) => !["readMask", "pageSize", "pageToken", "filter", "orderBy"].includes(k))) return apiError(400, "Invalid JSON payload received. Unknown name.");
          const mask = q.get("readMask");
          if (!mask) return apiError(400, "Request contains an invalid argument: read_mask is required.");
          const size = q.get("pageSize") === null ? 10 : Number(q.get("pageSize"));
          if (!Number.isInteger(size) || size < 1 || size > 100) return apiError(400, "Request contains an invalid argument: page_size.");
          reads.push({ what: "locations", location: null, page: q.get("pageToken"), range: null });
          const fields = mask.split(",");
          const got = page((data.locations ?? []).map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => fields.includes(k)))), size, q.get("pageToken"));
          if (!got) return apiError(400, "Request contains an invalid argument: page_token.");
          return { status: 200, body: { locations: got.rows, ...(got.next ? { nextPageToken: got.next } : {}) } };
        },
      },
    ],
  });

  const reviewsApi = checkDocMock({
    integration: "google_business_profile",
    baseUrl: `${REVIEWS}/v4`,
    source: { url: GBP_DOC_PAGES.review, title: "Google My Business API v4: accounts.locations.reviews", retrievedOn: "2026-11-11", version: "v4" },
    auth: "bearer",
    assumptions: ["A location the account doesn't manage answers 403", "Page tokens stay good for the length of a sync"],
    routes: [
      {
        method: "GET",
        path: "/accounts/{account}/locations/{location}/reviews",
        documentedAt: GBP_DOC_PAGES.reviews,
        respond(request, params) {
          const shut = gate(request);
          if (shut) return shut;
          if (params.account !== account || data.forbidden?.includes(params.location!)) return apiError(403, "The caller does not have permission");
          const q = request.url.searchParams;
          if ([...q.keys()].some((k) => !["pageSize", "pageToken", "orderBy"].includes(k))) return apiError(400, "Unknown name.");
          const size = q.get("pageSize") === null ? 50 : Number(q.get("pageSize"));
          const order = q.get("orderBy") ?? "updateTime desc";
          if (!Number.isInteger(size) || size < 1 || size > 50 || !["rating", "rating desc", "updateTime desc"].includes(order)) return apiError(400, "Request contains an invalid argument.");
          reads.push({ what: "reviews", location: params.location!, page: q.get("pageToken"), range: null });
          const all = [...(data.reviews?.[params.location!] ?? [])].sort((a, b) => (order === "updateTime desc" ? String(b.updateTime).localeCompare(String(a.updateTime)) : RATINGS.indexOf(String(a.starRating)) - RATINGS.indexOf(String(b.starRating))));
          const got = page(all, size, q.get("pageToken"));
          if (!got) return apiError(400, "Request contains an invalid argument: page_token.");
          return { status: 200, body: { reviews: got.rows, totalReviewCount: all.length, ...(all.length > 0 ? { averageRating: all.reduce((s, r) => s + RATINGS.indexOf(String(r.starRating)) + 1, 0) / all.length } : {}), ...(got.next ? { nextPageToken: got.next } : {}) } };
        },
      },
    ],
  });

  const performance = checkDocMock({
    integration: "google_business_profile",
    baseUrl: `${PERFORMANCE}/v1`,
    source: { url: GBP_DOC_PAGES.metrics, title: "Business Profile Performance API: locations.fetchMultiDailyMetricsTimeSeries", retrievedOn: "2026-11-11", version: "v1" },
    auth: "bearer",
    assumptions: ["A Date is {year, month, day}", "A range may cover any days the location has data for", "A location the account doesn't manage answers 403"],
    routes: [
      {
        method: "GET",
        path: "/locations/{call}",
        documentedAt: GBP_DOC_PAGES.metrics,
        respond(request, params) {
          const shut = gate(request);
          if (shut) return shut;
          const location = /^([0-9]{1,30}):fetchMultiDailyMetricsTimeSeries$/.exec(params.call!)?.[1];
          if (!location) return apiError(404, "Method not found.");
          if (data.forbidden?.includes(location)) return apiError(403, "The caller does not have permission");
          const q = request.url.searchParams;
          const known = ["dailyMetrics", ...["start_date", "end_date"].flatMap((e) => ["year", "month", "day"].map((k) => `dailyRange.${e}.${k}`))];
          if ([...q.keys()].some((k) => !known.includes(k))) return apiError(400, "Unknown name.");
          const metrics = q.getAll("dailyMetrics");
          const from = dateOf(q, "start_date");
          const to = dateOf(q, "end_date");
          if (metrics.length === 0 || metrics.some((m) => !METRIC_NAMES.has(m)) || !from || !to || to < from) return apiError(400, "Request contains an invalid argument.");
          reads.push({ what: "metrics", location, page: null, range: `${from}..${to}` });
          const values = data.metrics?.[location] ?? {};
          return {
            status: 200,
            body: {
              multiDailyMetricTimeSeries: [
                {
                  dailyMetricTimeSeries: metrics.map((m) => {
                    const datedValues: GbpMockRecord[] = [];
                    for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += 86_400_000) {
                      const day = new Date(ms).toISOString().slice(0, 10);
                      const v = values[m]?.[day] ?? 0;
                      const [year, month, d] = day.split("-").map(Number);
                      datedValues.push({ date: { year, month, day: d }, ...(v === 0 ? {} : { value: String(v) }) });
                    }
                    return { dailyMetric: m, timeSeries: { datedValues } };
                  }),
                },
              ],
            },
          };
        },
      },
    ],
  });

  const mocks = [oauth, information, reviewsApi, performance] as const;
  const fetches = mocks.map((m) => docMockFetch(m));
  const origins = [OAUTH, INFORMATION, REVIEWS, PERFORMANCE];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // An unknown host goes to the token mock, which refuses it.
      const i = Math.max(0, origins.findIndex((o) => url.startsWith(`${o}/`)));
      const response = await fetches[i]!(input, init);
      calls.push(...fetches[i]!.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    information,
    reviewsApi,
    performance,
    fetch,
    get reads() {
      return reads;
    },
    get refreshes() {
      return refreshes;
    },
    revokeTokens: () => access.clear(),
  };
}

export default {
  integration: "google_business_profile",
  covers: "Google's token refresh and Google Business Profile's location list (Business Information v1), review list (v4) and daily metrics (Performance v1), with page sizes, page tokens and date ranges",
  watchPages: [GBP_DOC_PAGES.oauth, GBP_DOC_PAGES.locations, GBP_DOC_PAGES.review, GBP_DOC_PAGES.reviews, GBP_DOC_PAGES.metrics],
  docMocks: () => {
    const mock = gbpDocMock({ clientId: "", clientSecret: "", refreshToken: "" });
    return [mock.oauth, mock.information, mock.reviewsApi, mock.performance];
  },
} satisfies DocMockModule;
