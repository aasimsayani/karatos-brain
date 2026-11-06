import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  GA4_MOCK_SCOPE,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  ga4ItemRow,
  ga4TrafficRow,
  googleAnalyticsDocMock,
  testPipeline,
  type GoogleAnalyticsMock,
  type GoogleAnalyticsMockData,
} from "@karatos/connector-testkit";
import {
  ANALYTICS_READONLY_SCOPE,
  GA4_EVENTS,
  GA4_MAX_RANGE_DAYS,
  GA4_PAGE_SIZE,
  GA4_REPORTS,
  GA4_REVISIT_DAYS,
  GA4_WRITES,
  GoogleAnalyticsApiError,
  GoogleAnalyticsConfigError,
  Ga4ShapeError,
  ga4Cents,
  ga4Count,
  ga4Day,
  ga4DayMs,
  ga4Label,
  ga4Page,
  ga4PageEvents,
  ga4ProductEvent,
  ga4ReportBody,
  ga4TrafficEvent,
  googleAnalyticsClient,
  googleAnalyticsConnector,
  googleAnalyticsScopeProblem,
  memoryTokenStore,
  parseGa4Cursor,
  type Ga4Cursor,
  type GoogleAnalyticsConnectorOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_SECRET = "c".repeat(24);
const REFRESH = `1//${"r".repeat(40)}`;
const PROPERTY = "123456789";
const NOW = () => new Date("2026-10-20T12:00:00Z");
const RECEIVED = "2026-10-20T12:00:00.000Z";
const CTX = { propertyId: PROPERTY, receivedAt: RECEIVED };
const RUN_URL = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`;
const AUTH = "https://www.googleapis.com/auth/";
const PAGE_META = { currency: "USD", timeZone: "America/New_York", thresholded: false };
const noSleep = async () => {};

function property(overrides: Partial<GoogleAnalyticsMockData> = {}): GoogleAnalyticsMockData {
  for (const b of [ga4TrafficRow, ga4ItemRow]) b.reset();
  // Four channels on 2026-10-01 and 2026-10-02, and one row on the first day of the two years.
  const traffic = [ga4TrafficRow.one({ date: "20241020" }), ...ga4TrafficRow.many(8)];
  const items = ga4ItemRow.many(3);
  return { propertyId: PROPERTY, traffic, items, refreshToken: REFRESH, ...overrides };
}

function connector(mock: GoogleAnalyticsMock, overrides: Partial<GoogleAnalyticsConnectorOptions> = {}) {
  return googleAnalyticsConnector({
    clientId: "test-client.apps.googleusercontent.com",
    clientSecret: CLIENT_SECRET,
    propertyId: PROPERTY,
    tokens: memoryTokenStore(REFRESH),
    fetch: mock.fetch,
    sleep: noSleep,
    now: NOW,
    ...overrides,
  });
}

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const ranges = (mock: GoogleAnalyticsMock) =>
  mock.reports.map((r) => {
    const range = (r.dateRanges as { startDate: string; endDate: string }[])[0]!;
    return `${(r.metrics as { name: string }[])[0]!.name} ${range.startDate}..${range.endDate}`;
  });

describe("Google Analytics 4 normalizer", () => {
  it("reads GA4's YYYYMMDD days and turns down anything that isn't a real day", () => {
    expect(ga4Day("20261001")).toBe("2026-10-01");
    expect(ga4Day("20240229")).toBe("2024-02-29");
    for (const bad of ["20230229", "20261301", "2026-10-01", "2026100", "(other)", 20261001, undefined]) expect(ga4Day(bad)).toBeUndefined();
  });

  it("reads counts only as strings of digits", () => {
    expect(ga4Count("0")).toBe(0);
    expect(ga4Count("12345")).toBe(12345);
    for (const bad of ["-1", "1.5", "1e3", "", " 3", 3, null, "9".repeat(16)]) expect(ga4Count(bad)).toBeUndefined();
  });

  it("reads money digit by digit into cents, rounding half away from zero", () => {
    expect(ga4Cents("1234.56")).toBe(123456);
    expect(ga4Cents("0.1")).toBe(10);
    expect(ga4Cents("19.995")).toBe(2000);
    expect(ga4Cents("19.9949999")).toBe(1999);
    expect(ga4Cents("1201.5000000000002")).toBe(120150);
    expect(ga4Cents("42")).toBe(4200);
    expect(ga4Cents("-15.255")).toBe(-1526);
    expect(ga4Cents("-0.001")).toBe(0);
    expect(Object.is(ga4Cents("-0.001"), 0)).toBe(true);
    for (const bad of ["1e3", "1.", ".5", "", "12,50", "$5", 12.5, null, "1".repeat(14)]) expect(ga4Cents(bad)).toBeUndefined();
  });

  it("keeps labels short and drops one that could be an email address", () => {
    expect(ga4Label("  google  ")).toBe("google");
    expect(ga4Label("x".repeat(300))).toHaveLength(120);
    expect(ga4Label("x".repeat(300), 10)).toHaveLength(10);
    for (const bad of ["customer1@example.test", "a@b", "   ", "", 5, undefined]) expect(ga4Label(bad)).toBeUndefined();
  });

  it("reads a page by the headers asked for, with the property's currency, time zone and thresholding", () => {
    const body = {
      dimensionHeaders: GA4_REPORTS.products.dimensions.map((name) => ({ name })),
      metricHeaders: GA4_REPORTS.products.metrics.map((name) => ({ name })),
      rows: [{ dimensionValues: [{ value: "20261001" }, { value: "TEST-RING-1" }, { value: "Test ring" }], metricValues: [{ value: "20" }, { value: "1" }, {}, { value: "2450.25" }] }],
      rowCount: 7,
      metadata: { currencyCode: "EUR", timeZone: "Europe/Paris", subjectToThresholding: true },
    };
    expect(ga4Page("products", body)).toEqual({
      rows: [{ dimensions: { date: "20261001", itemId: "TEST-RING-1", itemName: "Test ring" }, metrics: { itemsViewed: "20", itemsAddedToCart: "1", itemsPurchased: "", itemRevenue: "2450.25" } }],
      rowCount: 7,
      currency: "EUR",
      timeZone: "Europe/Paris",
      thresholded: true,
    });
    const odd = ga4Page("products", { ...body, rowCount: -1, metadata: { currencyCode: "usd", timeZone: "../etc" } });
    expect([odd.rowCount, odd.currency, odd.timeZone, odd.thresholded]).toEqual([1, undefined, undefined, false]);
  });

  it("reads an empty report with no headers as no rows, and throws on columns it didn't ask for", () => {
    expect(ga4Page("traffic", { metadata: {} })).toMatchObject({ rows: [], rowCount: 0 });
    expect(ga4Page("traffic", null)).toMatchObject({ rows: [], rowCount: 0 });
    const swapped = { dimensionHeaders: GA4_REPORTS.traffic.dimensions.map((name) => ({ name })), metricHeaders: [...GA4_REPORTS.traffic.metrics].reverse().map((name) => ({ name })), rows: [] };
    expect(() => ga4Page("traffic", swapped)).toThrow(Ga4ShapeError);
    expect(() => ga4Page("products", { dimensionHeaders: [{ name: "date" }], rows: [{}] })).toThrow("different columns than asked for");
  });

  const trafficRow = (overrides: Record<string, string> = {}) => ({
    dimensions: { date: "20261001", sessionDefaultChannelGroup: "Email", sessionSourceMedium: "newsletter / email", ...overrides },
    metrics: { sessions: "30", totalUsers: "24", newUsers: "9", engagedSessions: "18", keyEvents: "2", ecommercePurchases: "1", totalRevenue: "1203.5" },
  });

  it("turns a traffic row into analytics.traffic_reported with the day, channel and figures", () => {
    const e = ga4TrafficEvent(trafficRow(), PAGE_META, CTX);
    expect(e.type).toBe(GA4_EVENTS.traffic);
    expect(e.occurredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.idempotencyKey).toMatch(/^ga4:traffic:123456789:2026-10-01:[0-9a-f]{12}:[0-9a-f]{16}$/);
    expect(e.id).toBe(`ga4_${e.idempotencyKey.slice(4)}`);
    expect(e.payload).toEqual({
      propertyId: "ga4:property:123456789",
      day: "2026-10-01",
      channel: "Email",
      source: "newsletter",
      medium: "email",
      sessions: 30,
      users: 24,
      newUsers: 9,
      engagedSessions: 18,
      keyEvents: 2,
      purchases: 1,
      revenueCents: 120350,
      currency: "USD",
      timeZone: "America/New_York",
    });
    expect(ga4TrafficEvent(trafficRow(), { ...PAGE_META, thresholded: true }, CTX).payload.thresholded).toBe(true);
  });

  it("splits source / medium on the last separator and drops either side holding an @", () => {
    expect(ga4TrafficEvent(trafficRow({ sessionSourceMedium: "a / b / cpc" }), PAGE_META, CTX).payload).toMatchObject({ source: "a / b", medium: "cpc" });
    expect(ga4TrafficEvent(trafficRow({ sessionSourceMedium: "(direct)" }), PAGE_META, CTX).payload).toMatchObject({ source: "(direct)" });
    const tagged = ga4TrafficEvent(trafficRow({ sessionSourceMedium: "customer1@example.test / email", sessionDefaultChannelGroup: "" }), PAGE_META, CTX);
    expect(tagged.payload).toMatchObject({ channel: "(not set)", medium: "email" });
    expect(tagged.payload).not.toHaveProperty("source");
    expect(JSON.stringify(tagged)).not.toContain("@");
  });

  it("keys a traffic row by day and dimensions, and its numbers by digest", () => {
    const a = ga4TrafficEvent(trafficRow(), PAGE_META, CTX);
    expect(ga4TrafficEvent(trafficRow(), PAGE_META, { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    const revised = trafficRow();
    revised.metrics.sessions = "31";
    const b = ga4TrafficEvent(revised, PAGE_META, CTX);
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(b.idempotencyKey.split(":").slice(0, 5)).toEqual(a.idempotencyKey.split(":").slice(0, 5));
    const other = ga4TrafficEvent(trafficRow({ sessionSourceMedium: "newsletter / sms" }), PAGE_META, CTX);
    expect(other.idempotencyKey.split(":")[4]).not.toBe(a.idempotencyKey.split(":")[4]);
    expect(ga4TrafficEvent(trafficRow({ date: "20261002" }), PAGE_META, CTX).idempotencyKey).toContain(":2026-10-02:");
  });

  it("leaves a row with an unreadable day without an occurredAt, so it is dead-lettered", () => {
    const e = ga4TrafficEvent(trafficRow({ date: "(other)" }), PAGE_META, CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.idempotencyKey).toContain(":unknown:");
    expect(e.payload).not.toHaveProperty("day");
  });

  it("turns a product row into analytics.product_views_reported", () => {
    const row = { dimensions: { date: "20261001", itemId: "TEST-RING-1", itemName: "Test solitaire ring 1" }, metrics: { itemsViewed: "20", itemsAddedToCart: "1", itemsPurchased: "1", itemRevenue: "2450.25" } };
    const e = ga4ProductEvent(row, PAGE_META, CTX);
    expect(e.type).toBe(GA4_EVENTS.products);
    expect(e.occurredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(e.idempotencyKey).toMatch(/^ga4:product:123456789:2026-10-01:[0-9a-f]{12}:[0-9a-f]{16}$/);
    expect(e.payload).toEqual({
      propertyId: "ga4:property:123456789",
      day: "2026-10-01",
      itemId: "TEST-RING-1",
      itemName: "Test solitaire ring 1",
      views: 20,
      addedToCart: 1,
      purchased: 1,
      revenueCents: 245025,
      currency: "USD",
      timeZone: "America/New_York",
    });
    const unnamed = ga4ProductEvent({ ...row, dimensions: { date: "20261001", itemId: "", itemName: "gift for someone@example.test" } }, PAGE_META, CTX);
    expect(unnamed.payload.itemId).toBe("(not set)");
    expect(unnamed.payload).not.toHaveProperty("itemName");
    const other = ga4ProductEvent({ ...row, dimensions: { ...row.dimensions, itemId: "TEST-RING-2" } }, PAGE_META, CTX);
    expect(other.idempotencyKey.split(":")[4]).not.toBe(e.idempotencyKey.split(":")[4]);
    expect(ga4PageEvents("products", { ...PAGE_META, rows: [row], rowCount: 1 }, CTX).map((x) => x.type)).toEqual([GA4_EVENTS.products]);
    expect(ga4PageEvents("traffic", { ...PAGE_META, rows: [trafficRow()], rowCount: 1 }, CTX).map((x) => x.type)).toEqual([GA4_EVENTS.traffic]);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(property());
  });
});

describe("Google Analytics 4 client", () => {
  it("builds a runReport body only from the two fixed reports, a checked range and offset", () => {
    expect(ga4ReportBody({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-31", offset: 10_000 })).toEqual({
      dateRanges: [{ startDate: "2026-10-01", endDate: "2026-10-31" }],
      dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }, { name: "sessionSourceMedium" }],
      metrics: ["sessions", "totalUsers", "newUsers", "engagedSessions", "keyEvents", "ecommercePurchases", "totalRevenue"].map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "date" } }, { dimension: { dimensionName: "sessionDefaultChannelGroup" } }, { dimension: { dimensionName: "sessionSourceMedium" } }],
      limit: String(GA4_PAGE_SIZE),
      offset: "10000",
      keepEmptyRows: false,
    });
    expect(ga4ReportBody({ report: "products", startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 }).dimensions).toEqual([{ name: "date" }, { name: "itemId" }, { name: "itemName" }]);
    const ok = { report: "traffic" as const, startDate: "2026-10-01", endDate: "2026-10-02", offset: 0 };
    const bad: [unknown, string][] = [
      [{ ...ok, report: "audience" }, "only reads its two listed reports"],
      [{ ...ok, report: "toString" }, "only reads its two listed reports"],
      [{ ...ok, dimensionFilter: {} }, "doesn't take dimensionFilter"],
      [{ ...ok, startDate: "2026-02-30" }, "YYYY-MM-DD"],
      [{ ...ok, endDate: "today" }, "YYYY-MM-DD"],
      [{ ...ok, startDate: "2026-10-03" }, `1 to ${GA4_MAX_RANGE_DAYS} days`],
      [{ ...ok, endDate: "2026-11-01" }, `1 to ${GA4_MAX_RANGE_DAYS} days`],
      [{ ...ok, offset: -1 }, "whole number"],
      [{ ...ok, offset: 1.5 }, "whole number"],
    ];
    for (const [query, message] of bad) expect(() => ga4ReportBody(query as never), message).toThrow(message);
    expect(() => ga4ReportBody({ ...ok, endDate: "2026-10-31" })).not.toThrow();
    expect(ga4DayMs("2026-10-01")).toBe(Date.parse("2026-10-01T00:00:00Z"));
  });

  it("accepts analytics.readonly with sign-in scopes, and nothing broader", () => {
    expect(googleAnalyticsScopeProblem(ANALYTICS_READONLY_SCOPE)).toBeNull();
    expect(googleAnalyticsScopeProblem(`openid ${AUTH}userinfo.email ${ANALYTICS_READONLY_SCOPE}`)).toBeNull();
    expect(googleAnalyticsScopeProblem(`${ANALYTICS_READONLY_SCOPE} ${AUTH}analytics`)).toContain(`more than read-only access (${AUTH}analytics)`);
    expect(googleAnalyticsScopeProblem(`${ANALYTICS_READONLY_SCOPE} ${AUTH}analytics.edit`)).toContain("more than read-only");
    expect(googleAnalyticsScopeProblem(`${ANALYTICS_READONLY_SCOPE} ${AUTH}drive.readonly`)).toContain("more than read-only");
    expect(googleAnalyticsScopeProblem("openid")).toContain("doesn't hold");
    expect(googleAnalyticsScopeProblem("")).toContain("didn't say");
    expect(googleAnalyticsScopeProblem(undefined)).toContain("didn't say");
  });

  it("won't build without the OAuth client or with a property id that isn't digits", () => {
    const base = { clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY };
    expect(() => googleAnalyticsClient({ ...base, clientId: " " })).toThrow("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    expect(() => googleAnalyticsClient({ ...base, clientSecret: "" })).toThrow(GoogleAnalyticsConfigError);
    for (const id of ["G-TEST1234", "properties/123", "12 3", "", "1".repeat(21)]) expect(() => googleAnalyticsClient({ ...base, propertyId: id }), id).toThrow("numeric id");
    expect(googleAnalyticsClient({ ...base, propertyId: ` ${PROPERTY} ` }).propertyId).toBe(PROPERTY);
  });

  it("refreshes once, sends only runReport for the property with the token in the header, and reuses the token", async () => {
    const mock = googleAnalyticsDocMock(property());
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: mock.fetch, sleep: noSleep });
    await client.runReport({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-02", offset: 0 });
    await client.runReport({ report: "products", startDate: "2026-10-01", endDate: "2026-10-02", offset: 0 });
    expect(mock.refreshes).toBe(1);
    expect(mock.fetch.calls).toEqual([
      { method: "POST", url: "https://oauth2.googleapis.com/token" },
      { method: "POST", url: RUN_URL },
      { method: "POST", url: RUN_URL },
    ]);
    expect(mock.fetch.calls.some((c) => c.url.includes("AT-TEST"))).toBe(false);
  });

  it("sends the access token only in the Authorization header", async () => {
    const seen: { url: string; headers: [string, string][] }[] = [];
    const mock = googleAnalyticsDocMock(property());
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: [...new Headers(init?.headers).entries()] });
      return mock.fetch(input, init);
    }) as typeof fetch;
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: spy, sleep: noSleep });
    await client.runReport({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 });
    const run = seen.find((s) => s.url === RUN_URL)!;
    expect(run.headers.sort()).toEqual([["accept", "application/json"], ["authorization", "Bearer AT-TEST-1"], ["content-type", "application/json"]]);
  });

  it("renews the access token once on a 401", async () => {
    const mock = googleAnalyticsDocMock(property());
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: mock.fetch, sleep: noSleep });
    await client.runReport({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 });
    mock.revokeAccessTokens();
    await client.runReport({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 });
    expect(mock.refreshes).toBe(2);
    const always401 = async () => new Response(JSON.stringify({ error: { code: 401, message: "no", status: "UNAUTHENTICATED" } }), { status: 401 });
    let calls = 0;
    const counted = async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: `AT-${calls}`, scope: ANALYTICS_READONLY_SCOPE }), { status: 200 }) : always401();
    };
    const stuck = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: counted as typeof fetch, sleep: noSleep });
    await expect(stuck.runReport({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 })).rejects.toThrow("Google Analytics answered HTTP 401: no");
    expect(calls).toBe(4);
  });

  it("stops when the token holds more than analytics.readonly, before reading anything", async () => {
    const mock = googleAnalyticsDocMock(property({ scopes: [GA4_MOCK_SCOPE, `${AUTH}analytics`] }));
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: mock.fetch, sleep: noSleep });
    await expect(client.runReport({ report: "traffic", startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 })).rejects.toThrow(`reconnect it with only ${ANALYTICS_READONLY_SCOPE}`);
    expect(mock.fetch.calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token"]);
  });

  it("explains a revoked refresh token, a missing one and a failed refresh", async () => {
    const mock = googleAnalyticsDocMock(property({ refreshToken: "a-different-token" }));
    const make = (tokens = memoryTokenStore(REFRESH)) => googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens, propertyId: PROPERTY, fetch: mock.fetch, sleep: noSleep });
    const q = { report: "traffic" as const, startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 };
    const error = await make().runReport(q).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleAnalyticsApiError);
    expect((error as GoogleAnalyticsApiError).message).toBe("Google turned down the token refresh (HTTP 400, invalid_grant); reconnect Google Analytics to get a new refresh token (tokens from a consent screen in Testing last 7 days)");
    expect((error as GoogleAnalyticsApiError).reason).toBe("invalid_grant");
    expect((error as GoogleAnalyticsApiError).message).not.toContain(REFRESH);
    await expect(make(memoryTokenStore(" ")).runReport(q)).rejects.toThrow("set GOOGLE_ANALYTICS_REFRESH_TOKEN");
    const noToken = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, sleep: noSleep, fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    await expect(noToken.runReport(q)).rejects.toThrow("Google turned down the token refresh (HTTP 200)");
  });

  it("saves a refresh token Google returns and uses the access token's lifetime", async () => {
    const tokens = memoryTokenStore(REFRESH);
    let now = 0;
    let refreshes = 0;
    const fake = (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2")) {
        refreshes++;
        return new Response(JSON.stringify({ access_token: `AT-${refreshes}`, refresh_token: `1//${"n".repeat(30)}`, expires_in: 600, scope: ANALYTICS_READONLY_SCOPE }), { status: 200 });
      }
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    }) as typeof fetch;
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens, propertyId: PROPERTY, fetch: fake, sleep: noSleep, clock: () => now });
    const q = { report: "traffic" as const, startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 };
    await client.runReport(q);
    expect(tokens.current).toBe(`1//${"n".repeat(30)}`);
    now = 7 * 60_000;
    await client.runReport(q);
    expect(refreshes).toBe(1);
    // Renewed two minutes before the 10 minutes run out.
    now = 8 * 60_000 + 1;
    await client.runReport(q);
    expect(refreshes).toBe(2);
  });

  it("waits out a 429 a few times, honoring Retry-After up to a cap, then gives up with a clear error", async () => {
    const mock = googleAnalyticsDocMock(property({ rateLimited: 2 }));
    const waits: number[] = [];
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: mock.fetch, sleep: async (ms) => void waits.push(ms) });
    const q = { report: "traffic" as const, startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 };
    expect(ga4Page("traffic", await client.runReport(q)).rows).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);

    const sent: number[] = [];
    const limited = (after: string | null) =>
      (async (input: string | URL | Request) => {
        if (String(input).includes("oauth2")) return new Response(JSON.stringify({ access_token: "AT", scope: ANALYTICS_READONLY_SCOPE }), { status: 200 });
        sent.push(1);
        return new Response(JSON.stringify({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: after ? { "retry-after": after } : {} });
      }) as typeof fetch;
    const capped: number[] = [];
    const c2 = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: limited("900"), sleep: async (ms) => void capped.push(ms), rateLimitRetries: 2 });
    const error = await c2.runReport(q).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleAnalyticsApiError);
    expect((error as GoogleAnalyticsApiError).status).toBe(429);
    expect((error as GoogleAnalyticsApiError).reason).toBe("RESOURCE_EXHAUSTED");
    expect((error as Error).message).toContain("kept rate-limiting the sync");
    expect(capped).toEqual([64_000, 64_000]);
    expect(sent).toHaveLength(3);
  });

  it("explains a 403 as missing access to the property, and turns down an answer that isn't JSON", async () => {
    const mock = googleAnalyticsDocMock(property({ propertyId: "987654321" }));
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: mock.fetch, sleep: noSleep });
    const q = { report: "traffic" as const, startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 };
    const error = (await client.runReport(q).catch((e: unknown) => e)) as GoogleAnalyticsApiError;
    expect(error.message).toBe(`Google Analytics answered HTTP 403: User does not have sufficient permissions for this property.; the connected Google account needs Viewer access to property ${PROPERTY}`);
    expect(error.reason).toBe("PERMISSION_DENIED");
    const text = (async (input: string | URL | Request) =>
      String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "AT", scope: ANALYTICS_READONLY_SCOPE }), { status: 200 }) : new Response("<html>", { status: 200 })) as typeof fetch;
    const c2 = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: text, sleep: noSleep });
    await expect(c2.runReport(q)).rejects.toThrow("did not answer with JSON");
    const array = (async (input: string | URL | Request) =>
      String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "AT", scope: ANALYTICS_READONLY_SCOPE }), { status: 200 }) : new Response("[]", { status: 200 })) as typeof fetch;
    const c4 = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: array, sleep: noSleep });
    await expect(c4.runReport(q)).rejects.toThrow("did not answer with JSON");
    const server = (async (input: string | URL | Request) =>
      String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "AT", scope: ANALYTICS_READONLY_SCOPE }), { status: 200 }) : new Response(JSON.stringify({ error: "x".repeat(100) }), { status: 500 })) as typeof fetch;
    const c3 = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: server, sleep: noSleep });
    const e3 = (await c3.runReport(q).catch((e: unknown) => e)) as GoogleAnalyticsApiError;
    expect(e3.message).toBe("Google Analytics answered HTTP 500");
    expect(e3.reason).toHaveLength(40);
  });

  it("checks a report before any request is sent", async () => {
    const mock = googleAnalyticsDocMock(property());
    const client = googleAnalyticsClient({ clientId: "id", clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(REFRESH), propertyId: PROPERTY, fetch: mock.fetch, sleep: noSleep });
    await expect(client.runReport({ report: "pages" as never, startDate: "2026-10-01", endDate: "2026-10-01", offset: 0 })).rejects.toThrow(GoogleAnalyticsConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Google Analytics 4 connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(googleAnalyticsDocMock(property())), expected: { ingested: 12 } });
    expect(result.full.batches).toBe(2 * 24);
    expect(parseGa4Cursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", from: "2024-10-20", until: "2026-10-20" });
  });

  it("reads two years of traffic and then products in 31-day windows, up to today", async () => {
    const mock = googleAnalyticsDocMock(property());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(12);
    const read = ranges(mock);
    expect(read).toHaveLength(48);
    expect(read[0]).toBe("sessions 2024-10-20..2024-11-19");
    expect(read[1]).toBe("sessions 2024-11-20..2024-12-20");
    expect(read[23]).toMatch(/^sessions 2026-\d{2}-\d{2}\.\.2026-10-20$/);
    expect(read[24]).toBe("itemsViewed 2024-10-20..2024-11-19");
    expect(read[47]).toMatch(/^itemsViewed 2026-\d{2}-\d{2}\.\.2026-10-20$/);
    // Every day read once per report, with no gap or overlap between windows.
    for (const half of [read.slice(0, 24), read.slice(24)]) {
      for (let i = 1; i < half.length; i++) {
        const prevEnd = half[i - 1]!.split("..")[1]!;
        const start = half[i]!.split(" ")[1]!.split("..")[0]!;
        expect(ga4DayMs(start) - ga4DayMs(prevEnd)).toBe(86_400_000);
      }
    }
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === GA4_EVENTS.traffic)).toHaveLength(9);
    expect(types.filter((t) => t === GA4_EVENTS.products)).toHaveLength(3);
    expect(memory.events.every((e) => e.source === "google_analytics")).toBe(true);
  });

  it("pages through a window by offset until GA4's row count is read", async () => {
    const mock = googleAnalyticsDocMock(property({ pageCap: 3 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const last = mock.reports.filter((r) => {
      const range = (r.dateRanges as { startDate: string; endDate: string }[])[0]!;
      return range.startDate <= "2026-10-01" && range.endDate >= "2026-10-01" && (r.metrics as { name: string }[])[0]!.name === "sessions";
    });
    expect(last.map((r) => r.offset)).toEqual(["0", "3", "6"]);
    expect(batches.flatMap((b) => b.events).filter((e) => (e as { type: string }).type === GA4_EVENTS.traffic)).toHaveLength(9);
  });

  it("moves on when a page comes back empty though GA4 counted more rows", async () => {
    const queries: { report: string; offset: number }[] = [];
    const client = {
      propertyId: PROPERTY,
      runReport: async (q: { report: string; offset: number }) => {
        queries.push(q);
        return { rows: [], rowCount: 5 };
      },
    };
    const batches = await drain(connector(googleAnalyticsDocMock(property()), { client: client as never }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(queries.map((q) => `${q.report} ${q.offset}`)).toEqual(["traffic 0", "products 0"]);
    expect(batches).toHaveLength(2);
  });

  it("reads again from three days before the last day it read, storing revised rows as new versions", async () => {
    const data = property();
    const mock = googleAnalyticsDocMock(data);
    const { memory, pipeline } = testPipeline();
    let now = new Date("2026-10-04T12:00:00Z");
    const c = connector(mock, { now: () => now });
    await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["sessions 2026-10-01..2026-10-04", "itemsViewed 2026-10-01..2026-10-04"]);
    mock.reports.length = 0;
    // A late hit revises one row; nothing else changes.
    data.traffic[1]!.sessions = "11";
    now = new Date("2026-10-06T12:00:00Z");
    const report = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["sessions 2026-10-01..2026-10-06", "itemsViewed 2026-10-01..2026-10-06"]);
    expect(report.ingested).toBe(1);
    expect(report.duplicates).toBe(10);
    expect(GA4_REVISIT_DAYS).toBe(3);
  });

  it("starts an incremental sync with no checkpoint three days back", async () => {
    const mock = googleAnalyticsDocMock(property());
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(ranges(mock)).toEqual(["sessions 2026-10-17..2026-10-20", "itemsViewed 2026-10-17..2026-10-20"]);
  });

  it("resumes an unfinished pass from its checkpoint, and keeps a finished import finished", async () => {
    const mock = googleAnalyticsDocMock(property());
    const mid: Ga4Cursor = { pass: "incremental", step: "products", from: "2026-10-01", until: "2026-10-20", windowStart: "2026-10-01", offset: 0 };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(ranges(mock)).toEqual(["itemsViewed 2026-10-01..2026-10-20"]);
    mock.reports.length = 0;
    const done: Ga4Cursor = { ...mid, pass: "historical", step: "done" };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.reports).toEqual([]);
    // An incremental sync after a finished import reads from three days before its last day.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, until: "2026-10-15" }) }));
    expect(ranges(mock)[0]).toBe("sessions 2026-10-12..2026-10-20");
  });

  it("dead-letters a row with an unreadable day and stores the rest", async () => {
    const data = property();
    data.traffic.push(ga4TrafficRow.one({ date: "2026101A" }));
    const mock = googleAnalyticsDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // The mock's filter compares days as text, so the unreadable day falls inside the window.
    expect(report.deadLettered).toBe(1);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseGa4Cursor(null)).toBeNull();
    const ok: Ga4Cursor = { pass: "historical", step: "traffic", from: "2024-10-20", until: "2026-10-20", windowStart: "2025-01-01", offset: 0 };
    expect(parseGa4Cursor(JSON.stringify(ok))).toEqual(ok);
    const bad: unknown[] = [
      null,
      {},
      { ...ok, pass: "full" },
      { ...ok, step: "pages" },
      { ...ok, from: "2024-13-01" },
      { ...ok, until: undefined },
      { ...ok, from: "2026-10-21" },
      { ...ok, from: "2026-10-21", windowStart: "2026-10-21" },
      { ...ok, windowStart: "2024-10-19" },
      { ...ok, windowStart: "2026-10-21" },
      { ...ok, offset: -1 },
      { ...ok, offset: "0" },
    ];
    for (const c of bad) expect(() => parseGa4Cursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares no writes, so a read-only gate has nothing to let through", async () => {
    const c = connector(googleAnalyticsDocMock(property()));
    expect(GA4_WRITES).toEqual([]);
    expect(c.writes).toEqual([]);
    expect(c.source).toBe("google_analytics");
    expect(await assertWritesRefused(c)).toEqual([]);
  });

  it("never asks GA4 for anything but the two fixed reports", async () => {
    const mock = googleAnalyticsDocMock(property());
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    for (const r of mock.reports) {
      expect(Object.keys(r).sort()).toEqual(["dateRanges", "dimensions", "keepEmptyRows", "limit", "metrics", "offset", "orderBys"]);
      const dims = (r.dimensions as { name: string }[]).map((d) => d.name);
      expect([GA4_REPORTS.traffic.dimensions, GA4_REPORTS.products.dimensions].map((d) => JSON.stringify(d))).toContain(JSON.stringify(dims));
    }
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url}`))).toEqual(new Set(["POST https://oauth2.googleapis.com/token", `POST ${RUN_URL}`]));
  });
});
