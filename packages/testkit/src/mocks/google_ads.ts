import { createHash } from "node:crypto";
import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * The Google Ads API (REST, v26) search and mutate methods and Google's OAuth
 * token refresh, built from Google's developer docs. Data is synthetic: rows
 * hold every field the mock knows, and search answers with the ones the
 * query selects, nested and camelCased as the REST interface writes them.
 *
 * - search: POST /v26/customers/{id}/googleAds:search with `query` (GAQL)
 *   and `pageToken`; answers `results`, `nextPageToken` while rows remain
 *   and `fieldMask`, in fixed pages of 10,000 rows. A next page repeats the
 *   same query with the token.
 *   https://developers.google.com/google-ads/api/rest/common/search
 * - Every call needs `Authorization: Bearer` and a `developer-token`
 *   header; a manager account calling a client account adds
 *   `login-customer-id`, digits only. The one scope is adwords.
 *   https://developers.google.com/google-ads/api/rest/auth
 * - mutate: POST /v26/customers/{id}/googleAds:mutate. The mock counts each
 *   call, so a test can show the connector never sends one.
 *   https://developers.google.com/google-ads/api/rest/common/mutate
 * - Token refresh: POST https://oauth2.googleapis.com/token, answering the
 *   scopes the access token holds.
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 */
const OAUTH = "https://oauth2.googleapis.com";
const ADS = "https://googleads.googleapis.com/v26";
const DOCS = "https://developers.google.com/google-ads/api/rest";

export const GOOGLE_ADS_MOCK_SCOPE = "https://www.googleapis.com/auth/adwords";
/** Rows per page, fixed by Google. */
export const GOOGLE_ADS_MOCK_PAGE_SIZE = 10_000;

/** A day of one campaign's figures, with every field the mock knows. */
export interface GoogleAdsMockRow {
  date: string;
  campaignId: string;
  campaignName: string;
  status: string;
  channel: string;
  budgetMicros: string;
  impressions: string;
  clicks: string;
  costMicros: string;
  conversions: number;
  conversionsValue: number;
}

const CAMPAIGNS = [
  ["111", "Test bridal search", "SEARCH"],
  ["222", "Test shopping feed", "SHOPPING"],
  ["333", "Test local repairs", "PERFORMANCE_MAX"],
] as const;

/** Day n after 2026-10-01, cycling through three campaigns. */
export const googleAdsRow = fixtureBuilder<GoogleAdsMockRow>((n) => {
  const [campaignId, campaignName, channel] = CAMPAIGNS[(n - 1) % CAMPAIGNS.length]!;
  return {
    date: new Date(Date.parse("2026-10-01T00:00:00Z") + Math.floor((n - 1) / CAMPAIGNS.length) * 86_400_000).toISOString().slice(0, 10),
    campaignId,
    campaignName,
    status: "ENABLED",
    channel,
    budgetMicros: "25000000",
    impressions: String(100 * n),
    clicks: String(5 * n),
    costMicros: String(1_234_567 * n),
    conversions: n % 3 === 0 ? 1.5 : n % 2,
    conversionsValue: n % 2 ? 1450.25 : 0,
  };
});

export interface GoogleAdsMockData {
  /** The one account the connected user can read, 10 digits. */
  customerId: string;
  /** When set, the user reaches the account through this manager, which login-customer-id must name. */
  managerId?: string;
  developerToken: string;
  rows: GoogleAdsMockRow[];
  refreshToken: string;
  /** Scopes the refreshed token holds. Defaults to adwords. */
  scopes?: string[];
  currencyCode?: string;
  timeZone?: string;
  /** Rows per page the mock caps at, below Google's fixed 10,000, to exercise paging. */
  pageCap?: number;
  /** How many of the next search calls answer 429. */
  rateLimited?: number;
  /** The developer token has test access only, and the account isn't a test account. */
  testAccessOnly?: boolean;
}

export interface GoogleAdsMock {
  oauth: DocMock;
  api: DocMock;
  fetch: DocMockFetch;
  readonly refreshes: number;
  /** The JSON body of every search call, in order. */
  readonly searches: Record<string, unknown>[];
  /** The headers of every search call, lower-cased, in order. */
  readonly headers: Record<string, string>[];
  /** How many mutate calls were sent. */
  readonly mutations: number;
  revokeAccessTokens(): void;
}

/** Every field the mock can select, by its GAQL name, with where it sits in the REST answer. */
const FIELDS: Record<string, [string, string, (r: GoogleAdsMockRow, d: GoogleAdsMockData) => unknown]> = {
  "customer.currency_code": ["customer", "currencyCode", (_, d) => d.currencyCode ?? "USD"],
  "customer.time_zone": ["customer", "timeZone", (_, d) => d.timeZone ?? "America/New_York"],
  "campaign.id": ["campaign", "id", (r) => r.campaignId],
  "campaign.name": ["campaign", "name", (r) => r.campaignName],
  "campaign.status": ["campaign", "status", (r) => r.status],
  "campaign.advertising_channel_type": ["campaign", "advertisingChannelType", (r) => r.channel],
  "campaign_budget.amount_micros": ["campaignBudget", "amountMicros", (r) => r.budgetMicros],
  "segments.date": ["segments", "date", (r) => r.date],
  "metrics.impressions": ["metrics", "impressions", (r) => r.impressions],
  "metrics.clicks": ["metrics", "clicks", (r) => r.clicks],
  "metrics.cost_micros": ["metrics", "costMicros", (r) => r.costMicros],
  "metrics.conversions": ["metrics", "conversions", (r) => r.conversions],
  "metrics.conversions_value": ["metrics", "conversionsValue", (r) => r.conversionsValue],
};

const GAQL = /^SELECT (.+) FROM campaign WHERE segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})' ORDER BY segments\.date, campaign\.id$/;

const adsError = (code: number, status: string, message: string, errorCode?: Record<string, string>): DocMockResponse => ({
  status: code,
  body: {
    error: {
      code,
      message: errorCode ? "Request contains an invalid argument." : message,
      status,
      ...(errorCode ? { details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode, message }] }] } : {}),
    },
  },
});

const pageToken = (query: string, offset: number) => Buffer.from(`${createHash("sha256").update(query).digest("hex").slice(0, 12)}:${offset}`).toString("base64url");

export function googleAdsDocMock(data: GoogleAdsMockData): GoogleAdsMock {
  let refreshes = 0;
  let issued = 0;
  let mutations = 0;
  const access = new Set<string>();
  const searches: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const scopes = () => data.scopes ?? [GOOGLE_ADS_MOCK_SCOPE];

  const oauth = checkDocMock({
    integration: "google_ads",
    baseUrl: OAUTH,
    source: { url: "https://developers.google.com/identity/protocols/oauth2/web-server", title: "Using OAuth 2.0 for Web Server Applications", retrievedOn: "2026-10-30", version: "OAuth 2.0" },
    assumptions: ["A refresh answers access_token, expires_in, scope and token_type, and no new refresh_token", "An expired or revoked refresh token answers 400 invalid_grant"],
    routes: [
      {
        method: "POST",
        path: "/token",
        documentedAt: "https://developers.google.com/identity/protocols/oauth2",
        respond(request) {
          refreshes++;
          const form = new URLSearchParams(request.body);
          if (!form.get("client_id") || !form.get("client_secret")) return { status: 401, body: { error: "invalid_client" } };
          if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== data.refreshToken) return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
          const token = `AT-TEST-${++issued}`;
          access.add(token);
          return { status: 200, body: { access_token: token, expires_in: 3599, scope: scopes().join(" "), token_type: "Bearer" } };
        },
      },
    ],
  });

  // Checks shared by search and mutate: the token, the developer token, the scope and the account.
  function denied(request: { headers: Headers }, customer: string): DocMockResponse | null {
    if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return adsError(401, "UNAUTHENTICATED", "Request is missing required authentication credential.");
    if (request.headers.get("developer-token") !== data.developerToken) return adsError(401, "UNAUTHENTICATED", "The developer token is not valid.", { authenticationError: "DEVELOPER_TOKEN_INVALID" });
    if (!scopes().some((s) => s === GOOGLE_ADS_MOCK_SCOPE)) return adsError(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.");
    const login = request.headers.get("login-customer-id");
    if (login !== null && !/^\d{10}$/.test(login)) return adsError(400, "INVALID_ARGUMENT", "Invalid login-customer-id header.", { requestError: "INVALID_LOGIN_CUSTOMER_ID" });
    if (customer !== data.customerId || (data.managerId ? login !== data.managerId : login !== null && login !== data.customerId)) {
      return adsError(403, "PERMISSION_DENIED", "User doesn't have permission to access customer.", { authorizationError: "USER_PERMISSION_DENIED" });
    }
    if (data.testAccessOnly) return adsError(403, "PERMISSION_DENIED", "The developer token is only approved for use with test accounts.", { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" });
    return null;
  }

  const api = checkDocMock({
    integration: "google_ads",
    baseUrl: ADS,
    source: { url: `${DOCS}/common/search`, title: "Search and SearchStream (REST)", retrievedOn: "2026-10-30", version: "v26" },
    auth: "bearer",
    assumptions: [
      "int64 fields (ids, counts, micros) are JSON strings, and double fields (conversions, conversions_value) are JSON numbers",
      "segments.date comes back as YYYY-MM-DD",
      "A page token is good only for the query it came from",
      "A 429 for an exhausted quota answers RESOURCE_EXHAUSTED with no Retry-After",
      "A developer token with test access reading a production account answers 403 DEVELOPER_TOKEN_NOT_APPROVED",
    ],
    routes: [
      {
        method: "POST",
        path: "/customers/{customer}/{method}",
        documentedAt: `${DOCS}/common/search`,
        respond(request, params) {
          const customer = params.customer ?? "";
          const method = params.method;
          if (method === "googleAds:mutate") {
            mutations++;
            return denied(request, customer) ?? { status: 200, body: { mutateOperationResponses: [] } };
          }
          if (method !== "googleAds:search") return adsError(404, "NOT_FOUND", "Method not found.");
          const no = denied(request, customer);
          if (no) return no;
          if (data.rateLimited) {
            data.rateLimited--;
            return adsError(429, "RESOURCE_EXHAUSTED", "Too many requests. Retry in 30 seconds.", { quotaError: "RESOURCE_EXHAUSTED" });
          }
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(request.body) as Record<string, unknown>;
          } catch {
            return adsError(400, "INVALID_ARGUMENT", "Invalid JSON payload received.");
          }
          searches.push(body);
          headers.push(Object.fromEntries([...request.headers.entries()]));
          const query = typeof body.query === "string" ? body.query : "";
          const m = GAQL.exec(query);
          const selected = m ? m[1]!.split(", ") : [];
          if (!m || !selected.every((f) => Object.hasOwn(FIELDS, f))) return adsError(400, "INVALID_ARGUMENT", "Error in query.", { queryError: "UNRECOGNIZED_FIELD" });
          const [, , from, to] = m;
          if (to! < from!) return adsError(400, "INVALID_ARGUMENT", "Invalid date range.", { queryError: "INVALID_DATE_RANGE" });
          let offset = 0;
          if (body.pageToken !== undefined) {
            const parts = typeof body.pageToken === "string" ? Buffer.from(body.pageToken, "base64url").toString().split(":") : [];
            if (parts.length !== 2 || body.pageToken !== pageToken(query, Number(parts[1]))) return adsError(400, "INVALID_ARGUMENT", "Page token is invalid.", { requestError: "INVALID_PAGE_TOKEN" });
            offset = Number(parts[1]);
          }
          const rows = data.rows.filter((r) => r.date >= from! && r.date <= to!).sort((a, b) => (a.date === b.date ? Number(a.campaignId) - Number(b.campaignId) : a.date < b.date ? -1 : 1));
          const size = Math.min(GOOGLE_ADS_MOCK_PAGE_SIZE, data.pageCap ?? GOOGLE_ADS_MOCK_PAGE_SIZE);
          const page = rows.slice(offset, offset + size);
          const results = page.map((r) => {
            const out: Record<string, Record<string, unknown>> = {};
            for (const f of selected) {
              const [resource, field, read] = FIELDS[f]!;
              out[resource] ??= resource === "campaign" ? { resourceName: `customers/${customer}/campaigns/${r.campaignId}` } : {};
              out[resource]![field] = read(r, data);
            }
            return out;
          });
          return {
            status: 200,
            body: {
              ...(results.length ? { results } : {}),
              ...(offset + size < rows.length ? { nextPageToken: pageToken(query, offset + size) } : {}),
              fieldMask: selected.map((f) => FIELDS[f]!.slice(0, 2).join(".")).join(","),
            },
          };
        },
      },
    ],
  });

  const mocks = [
    { base: OAUTH, fetch: docMockFetch(oauth) },
    { base: ADS, fetch: docMockFetch(api) },
  ];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Routed by exact origin and path, so a look-alike host goes to the Ads mock and is turned down there.
      const target = mocks.find((m) => url.origin === new URL(m.base).origin && url.pathname.startsWith(new URL(m.base).pathname)) ?? mocks[1]!;
      const response = await target.fetch(input, init);
      calls.push(...target.fetch.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    api,
    fetch,
    get refreshes() {
      return refreshes;
    },
    searches,
    headers,
    get mutations() {
      return mutations;
    },
    revokeAccessTokens: () => access.clear(),
  };
}

export default {
  integration: "google_ads",
  covers: "The Google Ads API's `googleAds:search` and `googleAds:mutate` (REST, v26) with Google's token refresh, enforcing the developer token, the adwords scope, the account and manager headers, GAQL fields and page tokens tied to their query",
  watchPages: [
    "https://developers.google.com/identity/protocols/oauth2/web-server",
    "https://developers.google.com/identity/protocols/oauth2",
    "https://developers.google.com/google-ads/api/rest/common/search",
  ],
  docMocks: () => {
    const mock = googleAdsDocMock({ customerId: "1234567890", developerToken: "", rows: [], refreshToken: "" });
    return [mock.oauth, mock.api];
  },
} satisfies DocMockModule;
