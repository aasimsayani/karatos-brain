import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * The Google Analytics Data API (v1beta) runReport method and Google's OAuth
 * token refresh, built from Google's developer docs. Data is synthetic: rows
 * hold every dimension and metric the mock knows, and runReport answers with
 * the ones asked for.
 *
 * - runReport: POST /v1beta/properties/{id}:runReport with dateRanges,
 *   dimensions, metrics, orderBys, limit (default 10,000, at most 250,000)
 *   and offset; answers dimensionHeaders, metricHeaders, rows of
 *   dimensionValues and metricValues as strings, rowCount and metadata with
 *   currencyCode and timeZone. Needs analytics.readonly or analytics.
 *   https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
 * - Item-scoped dimensions and metrics (itemId, itemsViewed, ...) can't be
 *   mixed with event- or session-scoped ones in one report.
 *   https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema
 * - Token refresh: POST https://oauth2.googleapis.com/token, answering the
 *   scopes the access token holds.
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 */
const OAUTH = "https://oauth2.googleapis.com";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const DOCS = "https://developers.google.com/analytics/devguides/reporting/data/v1";

export const GA4_MOCK_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const READ_SCOPES = [GA4_MOCK_SCOPE, "https://www.googleapis.com/auth/analytics"];

/** A day of traffic for one channel and source / medium, with every metric the mock knows. */
export interface Ga4MockTrafficRow {
  date: string;
  sessionDefaultChannelGroup: string;
  sessionSourceMedium: string;
  sessions: string;
  totalUsers: string;
  newUsers: string;
  engagedSessions: string;
  keyEvents: string;
  ecommercePurchases: string;
  totalRevenue: string;
}

/** A day of one item's views, adds to cart and purchases. */
export interface Ga4MockItemRow {
  date: string;
  itemId: string;
  itemName: string;
  itemsViewed: string;
  itemsAddedToCart: string;
  itemsPurchased: string;
  itemRevenue: string;
}

const SESSION_FIELDS = ["date", "sessionDefaultChannelGroup", "sessionSourceMedium", "sessions", "totalUsers", "newUsers", "engagedSessions", "keyEvents", "ecommercePurchases", "totalRevenue"];
const ITEM_FIELDS = ["date", "itemId", "itemName", "itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"];

const ymd = (n: number, start: string) => new Date(Date.parse(`${start}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
const CHANNELS = [
  ["Organic Search", "google / organic"],
  ["Direct", "(direct) / (none)"],
  ["Email", "newsletter / email"],
  ["Paid Social", "instagram / paid"],
] as const;

/** Day n after 2026-10-01, cycling through four channels. */
export const ga4TrafficRow = fixtureBuilder<Ga4MockTrafficRow>((n) => {
  const [channel, sourceMedium] = CHANNELS[(n - 1) % CHANNELS.length]!;
  return {
    date: ymd(Math.floor((n - 1) / CHANNELS.length), "2026-10-01"),
    sessionDefaultChannelGroup: channel,
    sessionSourceMedium: sourceMedium,
    sessions: String(10 * n),
    totalUsers: String(8 * n),
    newUsers: String(3 * n),
    engagedSessions: String(6 * n),
    keyEvents: String(n % 3),
    ecommercePurchases: String(n % 2),
    totalRevenue: n % 2 ? `${1200 + n}.5` : "0",
  };
});

/** Item TEST-RING-n viewed on 2026-10-01. */
export const ga4ItemRow = fixtureBuilder<Ga4MockItemRow>((n) => ({
  date: "20261001",
  itemId: `TEST-RING-${n}`,
  itemName: `Test solitaire ring ${n}`,
  itemsViewed: String(20 * n),
  itemsAddedToCart: String(n),
  itemsPurchased: String(n % 2),
  itemRevenue: n % 2 ? "2450.25" : "0",
}));

export interface GoogleAnalyticsMockData {
  /** The one property the connected account can read. */
  propertyId: string;
  traffic: Ga4MockTrafficRow[];
  items: Ga4MockItemRow[];
  refreshToken: string;
  /** Scopes the refreshed token holds. Defaults to analytics.readonly. */
  scopes?: string[];
  currencyCode?: string;
  timeZone?: string;
  /** Rows per page the mock caps at, below the limit asked for, to exercise paging. */
  pageCap?: number;
  /** How many of the next runReport calls answer 429. */
  rateLimited?: number;
  /** Mark answers as subject to thresholding. */
  thresholded?: boolean;
}

export interface GoogleAnalyticsMock {
  oauth: DocMock;
  data: DocMock;
  fetch: DocMockFetch;
  readonly refreshes: number;
  /** The JSON body of every runReport call, in order. */
  readonly reports: Record<string, unknown>[];
  revokeAccessTokens(): void;
}

const apiError = (code: number, status: string, message: string): DocMockResponse => ({ status: code, body: { error: { code, message, status } } });
const dayOf = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replaceAll("-", "") : null);

export function googleAnalyticsDocMock(data: GoogleAnalyticsMockData): GoogleAnalyticsMock {
  let refreshes = 0;
  let issued = 0;
  const access = new Set<string>();
  const reports: Record<string, unknown>[] = [];
  const scopes = () => data.scopes ?? [GA4_MOCK_SCOPE];

  const oauth = checkDocMock({
    integration: "google_analytics",
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

  const api = checkDocMock({
    integration: "google_analytics",
    baseUrl: DATA,
    source: { url: `${DOCS}/rest/v1beta/properties/runReport`, title: "Method: properties.runReport", retrievedOn: "2026-10-30", version: "v1beta" },
    auth: "bearer",
    assumptions: [
      "orderBys on every dimension, in order, gives a stable order for paging by offset",
      "rowCount is the report's total rows, the same on every page",
      "limit and offset are sent as strings, as int64 fields are in Google's JSON",
      "A 429 for an exhausted quota answers RESOURCE_EXHAUSTED with no Retry-After",
      "A property the account can't read answers 403 PERMISSION_DENIED",
    ],
    routes: [
      {
        method: "POST",
        path: "/properties/{propertyMethod}",
        documentedAt: `${DOCS}/rest/v1beta/properties/runReport`,
        respond(request, params) {
          const [property, method] = (params.propertyMethod ?? "").split(":");
          if (method !== "runReport") return apiError(404, "NOT_FOUND", "Method not found.");
          if (!access.has(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) return apiError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
          if (!scopes().some((s) => READ_SCOPES.includes(s))) return apiError(403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.");
          if (property !== data.propertyId) return apiError(403, "PERMISSION_DENIED", "User does not have sufficient permissions for this property.");
          if (data.rateLimited) {
            data.rateLimited--;
            return apiError(429, "RESOURCE_EXHAUSTED", "Exhausted property tokens per hour for a project per property.");
          }
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(request.body) as Record<string, unknown>;
          } catch {
            return apiError(400, "INVALID_ARGUMENT", "Invalid JSON payload received.");
          }
          reports.push(body);
          const names = (key: string) => (Array.isArray(body[key]) ? (body[key] as { name?: unknown }[]).map((d) => String(d?.name)) : []);
          const dims = names("dimensions");
          const metrics = names("metrics");
          const all = [...dims, ...metrics];
          const itemScoped = all.every((n) => ITEM_FIELDS.includes(n));
          const sessionScoped = all.every((n) => SESSION_FIELDS.includes(n));
          if (!metrics.length || (!itemScoped && !sessionScoped)) return apiError(400, "INVALID_ARGUMENT", "Please remove incompatible dimensions or metrics from the request.");
          const range = Array.isArray(body.dateRanges) && body.dateRanges.length === 1 ? (body.dateRanges[0] as Record<string, unknown>) : {};
          const from = dayOf(range.startDate);
          const to = dayOf(range.endDate);
          if (!from || !to || to < from) return apiError(400, "INVALID_ARGUMENT", "Invalid date range.");
          const limit = Number(body.limit ?? 10_000);
          const offset = Number(body.offset ?? 0);
          if (!Number.isInteger(limit) || limit < 1 || limit > 250_000 || !Number.isInteger(offset) || offset < 0) return apiError(400, "INVALID_ARGUMENT", "limit must be positive and offset non-negative.");
          const source = (itemScoped && !sessionScoped ? data.items : data.traffic) as unknown as Record<string, string>[];
          const order = Array.isArray(body.orderBys) ? (body.orderBys as { dimension?: { dimensionName?: string } }[]).map((o) => o.dimension?.dimensionName ?? "") : [];
          const rows = source
            .filter((r) => r.date! >= from && r.date! <= to && metrics.some((m) => r[m] !== "0"))
            .sort((a, b) => {
              for (const d of order) if (a[d] !== b[d]) return a[d]! < b[d]! ? -1 : 1;
              return 0;
            });
          const page = rows.slice(offset, offset + Math.min(limit, data.pageCap ?? limit));
          return {
            status: 200,
            body: {
              dimensionHeaders: dims.map((name) => ({ name })),
              metricHeaders: metrics.map((name) => ({ name, type: name.toLowerCase().includes("revenue") ? "TYPE_CURRENCY" : "TYPE_INTEGER" })),
              ...(page.length ? { rows: page.map((r) => ({ dimensionValues: dims.map((d) => ({ value: r[d] })), metricValues: metrics.map((m) => ({ value: r[m] })) })) } : {}),
              ...(rows.length ? { rowCount: rows.length } : {}),
              metadata: { currencyCode: data.currencyCode ?? "USD", timeZone: data.timeZone ?? "America/New_York", ...(data.thresholded ? { subjectToThresholding: true } : {}) },
              kind: "analyticsData#runReport",
            },
          };
        },
      },
    ],
  });

  const mocks = [
    { base: OAUTH, fetch: docMockFetch(oauth) },
    { base: DATA, fetch: docMockFetch(api) },
  ];
  const calls: { method: string; url: string }[] = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Routed by exact origin and path, so a look-alike host goes to the Data API mock and is turned down there.
      const target = mocks.find((m) => url.origin === new URL(m.base).origin && url.pathname.startsWith(new URL(m.base).pathname)) ?? mocks[1]!;
      const response = await target.fetch(input, init);
      calls.push(...target.fetch.calls.slice(-1));
      return response;
    },
    { calls },
  );

  return {
    oauth,
    data: api,
    fetch,
    get refreshes() {
      return refreshes;
    },
    reports,
    revokeAccessTokens: () => access.clear(),
  };
}

export default {
  integration: "google_analytics",
  covers: "The Google Analytics Data API's `runReport` (v1beta) with Google's token refresh, enforcing analytics scopes, date ranges and the rule that item-scoped fields can't be mixed with session ones",
  watchPages: [
    "https://developers.google.com/identity/protocols/oauth2/web-server",
    "https://developers.google.com/identity/protocols/oauth2",
    "https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport",
  ],
  docMocks: () => {
    const mock = googleAnalyticsDocMock({ propertyId: "1", traffic: [], items: [], refreshToken: "" });
    return [mock.oauth, mock.data];
  },
} satisfies DocMockModule;
