import { describe, expect, it } from "vitest";
import { runSync, writePolicy, InMemoryWriteAuditLog, WriteGate, type SourceBatch } from "@karatos/core";
import {
  GOOGLE_ADS_MOCK_SCOPE,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  googleAdsDocMock,
  googleAdsRow,
  testPipeline,
  type GoogleAdsMock,
  type GoogleAdsMockData,
} from "@karatos/connector-testkit";
import {
  ADWORDS_SCOPE,
  GOOGLE_ADS_EVENTS,
  GOOGLE_ADS_FIELDS,
  GOOGLE_ADS_MAX_RANGE_DAYS,
  GOOGLE_ADS_REVISIT_DAYS,
  GOOGLE_ADS_WRITES,
  GoogleAdsApiError,
  GoogleAdsConfigError,
  GoogleAdsShapeError,
  googleAdsAmountCents,
  googleAdsCampaignEvent,
  googleAdsClient,
  googleAdsConnector,
  googleAdsConversions,
  googleAdsCount,
  googleAdsCustomerId,
  googleAdsDay,
  googleAdsDayMs,
  googleAdsLabel,
  googleAdsMicrosToCents,
  googleAdsPage,
  googleAdsPageEvents,
  googleAdsScopeProblem,
  googleAdsSearchBody,
  memoryTokenStore,
  parseGoogleAdsCursor,
  type GoogleAdsClientOptions,
  type GoogleAdsConnectorOptions,
  type GoogleAdsCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_SECRET = "c".repeat(24);
const REFRESH = `1//${"r".repeat(40)}`;
const DEV_TOKEN = "d".repeat(22);
const CUSTOMER = "1234567890";
const MANAGER = "1112223333";
const NOW = () => new Date("2026-10-20T12:00:00Z");
const RECEIVED = "2026-10-20T12:00:00.000Z";
const CTX = { customerId: CUSTOMER, receivedAt: RECEIVED };
const SEARCH_URL = `https://googleads.googleapis.com/v26/customers/${CUSTOMER}/googleAds:search`;
const AUTH = "https://www.googleapis.com/auth/";
const noSleep = async () => {};
const Q = { startDate: "2026-10-01", endDate: "2026-10-02", pageToken: null };

function account(overrides: Partial<GoogleAdsMockData> = {}): GoogleAdsMockData {
  googleAdsRow.reset();
  // Three campaigns on 2026-10-01 and 2026-10-02, and one row on the first day of the two years.
  const rows = [...googleAdsRow.many(6), googleAdsRow.one({ date: "2024-10-20" })];
  return { customerId: CUSTOMER, developerToken: DEV_TOKEN, rows, refreshToken: REFRESH, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch): GoogleAdsClientOptions => ({
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: CLIENT_SECRET,
  tokens: memoryTokenStore(REFRESH),
  developerToken: DEV_TOKEN,
  customerId: CUSTOMER,
  sleep: noSleep,
  ...(fetch ? { fetch } : {}),
});

function connector(mock: GoogleAdsMock, overrides: Partial<GoogleAdsConnectorOptions> = {}) {
  return googleAdsConnector({ ...base(mock.fetch), now: NOW, ...overrides });
}

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const ranges = (mock: GoogleAdsMock) => mock.searches.map((s) => /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(String(s.query))!.slice(1).join(".."));
/** A fetch that refreshes with the given scope, then answers every API call with `api`. */
const fake = (api: () => Response, scope = ADWORDS_SCOPE) =>
  (async (input: string | URL | Request) => (String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "AT", scope }), { status: 200 }) : api())) as typeof fetch;

const row = (overrides: { campaign?: Record<string, unknown>; metrics?: Record<string, unknown>; segments?: Record<string, unknown> } = {}) => ({
  customer: { currencyCode: "USD", timeZone: "America/New_York" },
  campaign: { resourceName: `customers/${CUSTOMER}/campaigns/111`, id: "111", name: "Test bridal search", status: "ENABLED", advertisingChannelType: "SEARCH", ...overrides.campaign },
  campaignBudget: { amountMicros: "25000000" },
  segments: { date: "2026-10-01", ...overrides.segments },
  metrics: { impressions: "100", clicks: "5", costMicros: "1234567", conversions: 1.5, conversionsValue: 1450.25, ...overrides.metrics },
});

describe("Google Ads normalizer", () => {
  it("reads days, int64 counts and micros, turning down anything else", () => {
    expect(googleAdsDay("2026-10-01")).toBe("2026-10-01");
    expect(googleAdsDay("2024-02-29")).toBe("2024-02-29");
    for (const bad of ["2023-02-29", "2026-13-01", "20261001", "", 20261001, undefined]) expect(googleAdsDay(bad)).toBeUndefined();
    expect(googleAdsCount("0")).toBe(0);
    expect(googleAdsCount("12345")).toBe(12345);
    for (const bad of ["-1", "1.5", "1e3", "", " 3", 3, null, "9".repeat(16)]) expect(googleAdsCount(bad)).toBeUndefined();
    expect(googleAdsMicrosToCents("1234567")).toBe(123);
    expect(googleAdsMicrosToCents("1235000")).toBe(124);
    expect(googleAdsMicrosToCents("1234999")).toBe(123);
    expect(googleAdsMicrosToCents("25000000")).toBe(2500);
    expect(googleAdsMicrosToCents("0")).toBe(0);
    for (const bad of ["-5000", "1.5", 1234567, undefined]) expect(googleAdsMicrosToCents(bad)).toBeUndefined();
  });

  it("reads conversion value and conversions from JSON numbers", () => {
    expect(googleAdsAmountCents(1450.25)).toBe(145025);
    expect(googleAdsAmountCents(0.005)).toBe(1);
    expect(googleAdsAmountCents(0)).toBe(0);
    expect(googleAdsAmountCents(1e13)).toBe(1e15);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e13 + 1, "1450.25", null]) expect(googleAdsAmountCents(bad)).toBeUndefined();
    expect(googleAdsConversions(1.5)).toBe(1.5);
    expect(googleAdsConversions(2.3333333)).toBe(2.33);
    expect(googleAdsConversions(1e13)).toBe(1e13);
    for (const bad of [-0.5, Number.NaN, 1e13 + 1, "2"]) expect(googleAdsConversions(bad)).toBeUndefined();
  });

  it("keeps campaign names short and drops one that could be an email address", () => {
    expect(googleAdsLabel("  Test bridal  ")).toBe("Test bridal");
    expect(googleAdsLabel("x".repeat(300))).toHaveLength(200);
    expect(googleAdsLabel("x".repeat(300), 10)).toHaveLength(10);
    for (const bad of ["customer1@example.test", "   ", "", 5, undefined]) expect(googleAdsLabel(bad)).toBeUndefined();
  });

  it("reads a page's rows and next page token, and throws on results that aren't a list", () => {
    const page = googleAdsPage({ results: [row(), "junk"], nextPageToken: "abc", fieldMask: "campaign.id" });
    expect(page.nextPageToken).toBe("abc");
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]!.campaign!.id).toBe("111");
    expect(page.rows[1]).toEqual({ customer: {}, campaign: {}, campaignBudget: {}, segments: {}, metrics: {} });
    expect(googleAdsPage({ fieldMask: "x" })).toEqual({ rows: [], nextPageToken: undefined });
    expect(googleAdsPage(null)).toEqual({ rows: [], nextPageToken: undefined });
    expect(googleAdsPage({ nextPageToken: "" }).nextPageToken).toBeUndefined();
    expect(googleAdsPage({ nextPageToken: 5 }).nextPageToken).toBeUndefined();
    expect(() => googleAdsPage({ results: {} })).toThrow(GoogleAdsShapeError);
    expect(() => googleAdsPage({ results: "rows" })).toThrow("results that aren't a list");
  });

  it("turns a row into ads.campaign_reported with the day, campaign and figures in cents", () => {
    const e = googleAdsCampaignEvent(row(), CTX);
    expect(e.type).toBe(GOOGLE_ADS_EVENTS.campaign);
    expect(e.occurredAt).toBe("2026-10-01T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.idempotencyKey).toMatch(/^gads:campaign:1234567890:2026-10-01:111:[0-9a-f]{16}$/);
    expect(e.id).toBe(`gads_${e.idempotencyKey.slice(5)}`);
    expect(e.payload).toEqual({
      customerId: "google_ads:customer:1234567890",
      day: "2026-10-01",
      campaignId: "google_ads:campaign:111",
      campaignName: "Test bridal search",
      status: "ENABLED",
      channel: "SEARCH",
      dailyBudgetCents: 2500,
      impressions: 100,
      clicks: 5,
      costCents: 123,
      conversions: 1.5,
      conversionValueCents: 145025,
      currency: "USD",
      timeZone: "America/New_York",
    });
  });

  it("drops a campaign name holding an @, and a status, channel, currency or time zone it can't trust", () => {
    const odd = googleAdsCampaignEvent(
      { ...row({ campaign: { name: "for customer1@example.test", status: "enabled", advertisingChannelType: "A".repeat(41) } }), customer: { currencyCode: "usd", timeZone: "../etc" } },
      CTX,
    );
    for (const field of ["campaignName", "status", "channel", "currency", "timeZone"]) expect(odd.payload, field).not.toHaveProperty(field);
    expect(JSON.stringify(odd)).not.toContain("@");
    expect(googleAdsCampaignEvent(row({ campaign: { advertisingChannelType: "A".repeat(40) } }), CTX).payload.channel).toHaveLength(40);
    expect(googleAdsCampaignEvent({ ...row(), customer: { currencyCode: "EUR", timeZone: "Europe/Paris" } }, CTX).payload).toMatchObject({ currency: "EUR", timeZone: "Europe/Paris" });
  });

  it("keys a row by day and campaign, and its numbers by digest", () => {
    const a = googleAdsCampaignEvent(row(), CTX);
    expect(googleAdsCampaignEvent(row(), { ...CTX, receivedAt: "2026-10-21T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    const revised = googleAdsCampaignEvent(row({ metrics: { conversions: 2 } }), CTX);
    expect(revised.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(revised.idempotencyKey.split(":").slice(0, 5)).toEqual(a.idempotencyKey.split(":").slice(0, 5));
    expect(googleAdsCampaignEvent(row({ campaign: { id: "222" } }), CTX).idempotencyKey).toContain(":222:");
    expect(googleAdsCampaignEvent(row({ segments: { date: "2026-10-02" } }), CTX).idempotencyKey).toContain(":2026-10-02:");
  });

  it("leaves a row with an unreadable day without an occurredAt, and a campaign id that isn't digits as unknown", () => {
    const e = googleAdsCampaignEvent(row({ segments: { date: "yesterday" }, campaign: { id: "../1" } }), CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.idempotencyKey).toContain(":unknown:unknown:");
    expect(e.payload).not.toHaveProperty("day");
    expect(e.payload.campaignId).toBe("google_ads:campaign:unknown");
    expect(googleAdsPageEvents({ rows: [row(), row()], nextPageToken: undefined }, CTX).map((x) => x.type)).toEqual([GOOGLE_ADS_EVENTS.campaign, GOOGLE_ADS_EVENTS.campaign]);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Google Ads client", () => {
  it("builds a search body only from the fixed report, a checked range and Google's page token", () => {
    expect(googleAdsSearchBody({ startDate: "2026-10-01", endDate: "2026-10-31", pageToken: null })).toEqual({
      query: `SELECT ${GOOGLE_ADS_FIELDS.join(", ")} FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY segments.date, campaign.id`,
    });
    expect(googleAdsSearchBody({ ...Q, pageToken: "Q2Fy-dG9r_ZW4=" }).pageToken).toBe("Q2Fy-dG9r_ZW4=");
    const bad: [unknown, string][] = [
      [{ ...Q, where: "campaign.status = 'ENABLED'" }, "doesn't take where"],
      [{ ...Q, startDate: "2026-02-30" }, "YYYY-MM-DD"],
      [{ ...Q, endDate: "2026-10-02' OR '1'='1" }, "YYYY-MM-DD"],
      [{ ...Q, startDate: "2026-10-03" }, `1 to ${GOOGLE_ADS_MAX_RANGE_DAYS} days`],
      [{ ...Q, endDate: "2026-11-01" }, `1 to ${GOOGLE_ADS_MAX_RANGE_DAYS} days`],
      [{ ...Q, pageToken: "a b" }, "pageToken"],
      [{ ...Q, pageToken: "" }, "pageToken"],
      [{ ...Q, pageToken: "x".repeat(2049) }, "pageToken"],
      [{ ...Q, pageToken: 5 }, "pageToken"],
    ];
    for (const [query, message] of bad) expect(() => googleAdsSearchBody(query as never), message).toThrow(message);
    expect(() => googleAdsSearchBody({ ...Q, endDate: "2026-10-31" })).not.toThrow();
    expect(googleAdsDayMs("2026-10-01")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    for (const bad of ["2026-02-30", "20261001", 5]) expect(googleAdsDayMs(bad)).toBeNaN();
  });

  it("accepts the adwords scope with sign-in scopes, and nothing more", () => {
    expect(googleAdsScopeProblem(ADWORDS_SCOPE)).toBeNull();
    expect(googleAdsScopeProblem(`openid ${AUTH}userinfo.email ${ADWORDS_SCOPE}`)).toBeNull();
    expect(googleAdsScopeProblem(`${ADWORDS_SCOPE} ${AUTH}drive.readonly`)).toBe(`the Google Ads connection holds more than the Google Ads scope (${AUTH}drive.readonly)`);
    expect(googleAdsScopeProblem(`${AUTH}analytics.readonly`)).toContain("more than the Google Ads scope");
    expect(googleAdsScopeProblem("openid")).toContain("doesn't hold");
    expect(googleAdsScopeProblem("")).toContain("didn't say");
    expect(googleAdsScopeProblem(undefined)).toContain("didn't say");
  });

  it("reads customer ids with or without dashes, and won't build without its settings", () => {
    expect(googleAdsCustomerId(" 123-456-7890 ")).toBe(CUSTOMER);
    expect(googleAdsCustomerId(CUSTOMER)).toBe(CUSTOMER);
    for (const id of ["123-4567-890", "123456789", "12345678901", "abc-def-ghij", "", 1234567890]) expect(googleAdsCustomerId(id), String(id)).toBeUndefined();
    expect(() => googleAdsClient({ ...base(), clientId: " " })).toThrow("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    expect(() => googleAdsClient({ ...base(), clientSecret: "" })).toThrow(GoogleAdsConfigError);
    for (const token of ["", "has space", "x".repeat(201)]) expect(() => googleAdsClient({ ...base(), developerToken: token })).toThrow("set GOOGLE_ADS_DEVELOPER_TOKEN");
    expect(() => googleAdsClient({ ...base(), customerId: "123" })).toThrow("10-digit customer id");
    expect(() => googleAdsClient({ ...base(), loginCustomerId: "456" })).toThrow("GOOGLE_ADS_LOGIN_CUSTOMER_ID must be the manager account's 10-digit customer id");
    expect(googleAdsClient({ ...base(), customerId: "123-456-7890", loginCustomerId: " " }).customerId).toBe(CUSTOMER);
  });

  it("refreshes once, sends only googleAds:search for the account with its headers, and reuses the token", async () => {
    const mock = googleAdsDocMock(account());
    const client = googleAdsClient(base(mock.fetch));
    await client.search(Q);
    await client.search({ ...Q, endDate: "2026-10-01" });
    expect(mock.refreshes).toBe(1);
    expect(mock.fetch.calls).toEqual([
      { method: "POST", url: "https://oauth2.googleapis.com/token" },
      { method: "POST", url: SEARCH_URL },
      { method: "POST", url: SEARCH_URL },
    ]);
    const sent = Object.entries(mock.headers[0]!).sort();
    expect(sent).toEqual([
      ["accept", "application/json"],
      ["authorization", "Bearer AT-TEST-1"],
      ["content-type", "application/json"],
      ["developer-token", DEV_TOKEN],
    ]);
    expect(mock.fetch.calls.some((c) => c.url.includes("AT-TEST") || c.url.includes(DEV_TOKEN))).toBe(false);
  });

  it("names the manager account in login-customer-id when one is set, digits only", async () => {
    const mock = googleAdsDocMock(account({ managerId: MANAGER }));
    await expect(googleAdsClient(base(mock.fetch)).search(Q)).rejects.toThrow("set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account");
    const client = googleAdsClient({ ...base(mock.fetch), loginCustomerId: "111-222-3333" });
    expect(googleAdsPage(await client.search(Q)).rows).toHaveLength(6);
    expect(mock.headers.at(-1)!["login-customer-id"]).toBe(MANAGER);
  });

  it("renews the access token once on a 401", async () => {
    const mock = googleAdsDocMock(account());
    const client = googleAdsClient(base(mock.fetch));
    await client.search(Q);
    mock.revokeAccessTokens();
    await client.search(Q);
    expect(mock.refreshes).toBe(2);
    let calls = 0;
    const counted = (async (input: string | URL | Request) => {
      calls++;
      return String(input).includes("oauth2")
        ? new Response(JSON.stringify({ access_token: `AT-${calls}`, scope: ADWORDS_SCOPE }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 401, message: "no", status: "UNAUTHENTICATED" } }), { status: 401 });
    }) as typeof fetch;
    await expect(googleAdsClient(base(counted)).search(Q)).rejects.toThrow("Google Ads answered HTTP 401: no");
    expect(calls).toBe(4);
  });

  it("stops when the token holds more than the Google Ads scope, before reading anything", async () => {
    const mock = googleAdsDocMock(account({ scopes: [GOOGLE_ADS_MOCK_SCOPE, `${AUTH}gmail.readonly`] }));
    await expect(googleAdsClient(base(mock.fetch)).search(Q)).rejects.toThrow(`reconnect it with only ${ADWORDS_SCOPE}`);
    expect(mock.fetch.calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token"]);
  });

  it("explains a revoked refresh token, a missing one and a failed refresh", async () => {
    const mock = googleAdsDocMock(account({ refreshToken: "a-different-token" }));
    const error = (await googleAdsClient(base(mock.fetch))
      .search(Q)
      .catch((e: unknown) => e)) as GoogleAdsApiError;
    expect(error).toBeInstanceOf(GoogleAdsApiError);
    expect(error.message).toBe("Google turned down the token refresh (HTTP 400, invalid_grant); reconnect Google Ads to get a new refresh token (tokens from a consent screen in Testing last 7 days)");
    expect(error.reason).toBe("invalid_grant");
    expect(error.message).not.toContain(REFRESH);
    await expect(googleAdsClient({ ...base(mock.fetch), tokens: memoryTokenStore(" ") }).search(Q)).rejects.toThrow("set GOOGLE_ADS_REFRESH_TOKEN");
    await expect(googleAdsClient(base((async () => new Response("{}", { status: 200 })) as typeof fetch)).search(Q)).rejects.toThrow("Google turned down the token refresh (HTTP 200)");
    const other = (await googleAdsClient(base((async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as typeof fetch))
      .search(Q)
      .catch((e: unknown) => e)) as GoogleAdsApiError;
    expect(other.message).toBe("Google turned down the token refresh (HTTP 401, invalid_client)");
    await expect(googleAdsClient(base((async () => new Response("<html>", { status: 502 })) as typeof fetch)).search(Q)).rejects.toThrow("Google turned down the token refresh (HTTP 502)");
  });

  it("saves a refresh token Google returns and uses the access token's lifetime", async () => {
    const tokens = memoryTokenStore(REFRESH);
    let now = 0;
    let refreshes = 0;
    const counted = (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2")) {
        refreshes++;
        return new Response(JSON.stringify({ access_token: `AT-${refreshes}`, refresh_token: `1//${"n".repeat(30)}`, expires_in: 600, scope: ADWORDS_SCOPE }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = googleAdsClient({ ...base(counted), tokens, clock: () => now });
    await client.search(Q);
    expect(tokens.current).toBe(`1//${"n".repeat(30)}`);
    now = 7 * 60_000;
    await client.search(Q);
    expect(refreshes).toBe(1);
    // Renewed two minutes before the 10 minutes run out.
    now = 8 * 60_000 + 1;
    await client.search(Q);
    expect(refreshes).toBe(2);
    // With no lifetime given, an hour.
    let at = 0;
    let n = 0;
    const noLife = (async (input: string | URL | Request) =>
      String(input).includes("oauth2") ? (n++, new Response(JSON.stringify({ access_token: "AT", scope: ADWORDS_SCOPE }), { status: 200 })) : new Response("{}", { status: 200 })) as typeof fetch;
    const hourly = googleAdsClient({ ...base(noLife), clock: () => at });
    await hourly.search(Q);
    at = 57 * 60_000;
    await hourly.search(Q);
    expect(n).toBe(1);
    at = 58 * 60_000 + 1;
    await hourly.search(Q);
    expect(n).toBe(2);
  });

  it("refreshes once for searches sent together", async () => {
    const mock = googleAdsDocMock(account());
    const client = googleAdsClient(base(mock.fetch));
    await Promise.all([client.search(Q), client.search(Q)]);
    expect(mock.refreshes).toBe(1);
  });

  it("waits out a 429 a few times, honoring Retry-After up to a cap, then gives up with a clear error", async () => {
    const mock = googleAdsDocMock(account({ rateLimited: 2 }));
    const waits: number[] = [];
    const client = googleAdsClient({ ...base(mock.fetch), sleep: async (ms) => void waits.push(ms) });
    expect(googleAdsPage(await client.search(Q)).rows).toHaveLength(6);
    expect(waits).toEqual([1000, 2000]);

    let sent = 0;
    const limited = (after: string | null) =>
      fake(() => {
        sent++;
        return new Response(JSON.stringify({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: after ? { "retry-after": after } : {} });
      });
    const capped: number[] = [];
    const error = (await googleAdsClient({ ...base(limited("900")), sleep: async (ms) => void capped.push(ms), rateLimitRetries: 2 })
      .search(Q)
      .catch((e: unknown) => e)) as GoogleAdsApiError;
    expect(error).toBeInstanceOf(GoogleAdsApiError);
    expect([error.status, error.reason]).toEqual([429, "RESOURCE_EXHAUSTED"]);
    expect(error.message).toContain("kept rate-limiting the sync");
    expect(capped).toEqual([64_000, 64_000]);
    expect(sent).toBe(3);
    const short: number[] = [];
    await googleAdsClient({ ...base(limited("3")), sleep: async (ms) => void short.push(ms), rateLimitRetries: 1 })
      .search(Q)
      .catch(() => {});
    expect(short).toEqual([3000]);
    const doubling: number[] = [];
    await googleAdsClient({ ...base(limited(null)), sleep: async (ms) => void doubling.push(ms), rateLimitRetries: 8 })
      .search(Q)
      .catch(() => {});
    expect(doubling).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
  });

  it("explains a missing account grant and a test-only developer token by Google Ads' own error code", async () => {
    const elsewhere = (await googleAdsClient(base(googleAdsDocMock(account({ customerId: "9998887777" })).fetch))
      .search(Q)
      .catch((e: unknown) => e)) as GoogleAdsApiError;
    expect(elsewhere.message).toBe(
      `Google Ads answered HTTP 403: User doesn't have permission to access customer.; the connected Google account needs access to account ${CUSTOMER}, or set GOOGLE_ADS_LOGIN_CUSTOMER_ID to the manager account it reaches it through`,
    );
    expect(elsewhere.reason).toBe("USER_PERMISSION_DENIED");
    const test = (await googleAdsClient(base(googleAdsDocMock(account({ testAccessOnly: true })).fetch))
      .search(Q)
      .catch((e: unknown) => e)) as GoogleAdsApiError;
    expect(test.message).toBe("Google Ads answered HTTP 403: The developer token is only approved for use with test accounts.; a developer token with test access reads test accounts only, so apply for Basic access in the API Center");
    expect(test.reason).toBe("DEVELOPER_TOKEN_NOT_APPROVED");
    const wrongToken = (await googleAdsClient({ ...base(googleAdsDocMock(account()).fetch), developerToken: "e".repeat(22) })
      .search(Q)
      .catch((e: unknown) => e)) as GoogleAdsApiError;
    expect([wrongToken.status, wrongToken.reason, wrongToken.message]).toEqual([401, "DEVELOPER_TOKEN_INVALID", "Google Ads answered HTTP 401: The developer token is not valid."]);
    expect(wrongToken.message).not.toContain("e".repeat(22));
  });

  it("turns down an answer that isn't a JSON object, and cuts a long error short", async () => {
    await expect(googleAdsClient(base(fake(() => new Response("<html>", { status: 200 })))).search(Q)).rejects.toThrow("did not answer with JSON");
    await expect(googleAdsClient(base(fake(() => new Response("[]", { status: 200 })))).search(Q)).rejects.toThrow("did not answer with JSON");
    const e = (await googleAdsClient(base(fake(() => new Response(JSON.stringify({ error: "x".repeat(100) }), { status: 500 }))))
      .search(Q)
      .catch((x: unknown) => x)) as GoogleAdsApiError;
    expect(e.message).toBe("Google Ads answered HTTP 500");
    expect(e.reason).toHaveLength(40);
    const long = (await googleAdsClient(base(fake(() => new Response(JSON.stringify({ error: { message: "m".repeat(300), status: "S".repeat(50) } }), { status: 400 }))))
      .search(Q)
      .catch((x: unknown) => x)) as GoogleAdsApiError;
    expect(long.message).toBe(`Google Ads answered HTTP 400: ${"m".repeat(200)}`);
    expect(long.reason).toBe("S".repeat(40));
    const bare = (await googleAdsClient(base(fake(() => new Response(JSON.stringify({ error: { details: [{ errors: [{ errorCode: { queryError: 7 } }] }] } }), { status: 400 }))))
      .search(Q)
      .catch((x: unknown) => x)) as GoogleAdsApiError;
    expect([bare.message, bare.reason]).toEqual(["Google Ads answered HTTP 400", undefined]);
  });

  it("checks a query before any request is sent", async () => {
    const mock = googleAdsDocMock(account());
    await expect(googleAdsClient(base(mock.fetch)).search({ ...Q, startDate: "today" })).rejects.toThrow(GoogleAdsConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Google Ads connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(googleAdsDocMock(account())), expected: { ingested: 7 } });
    expect(result.full.batches).toBe(24);
    expect(parseGoogleAdsCursor(result.full.cursor)).toMatchObject({ pass: "historical", done: true, from: "2024-10-20", until: "2026-10-20" });
  });

  it("reads two years in 31-day windows, up to today, with no gap or overlap", async () => {
    const mock = googleAdsDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    const read = ranges(mock);
    expect(read).toHaveLength(24);
    expect(read[0]).toBe("2024-10-20..2024-11-19");
    expect(read[1]).toBe("2024-11-20..2024-12-20");
    expect(read[23]).toMatch(/^2026-\d{2}-\d{2}\.\.2026-10-20$/);
    for (let i = 1; i < read.length; i++) expect(googleAdsDayMs(read[i]!.split("..")[0]) - googleAdsDayMs(read[i - 1]!.split("..")[1])).toBe(86_400_000);
    expect(memory.events.every((e) => e.source === "google_ads" && e.type === GOOGLE_ADS_EVENTS.campaign)).toBe(true);
  });

  it("pages through a window with Google's token, repeating the same query", async () => {
    const mock = googleAdsDocMock(account({ pageCap: 4 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const october = mock.searches.filter((s) => {
      const [from, to] = /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(String(s.query))!.slice(1);
      return from! <= "2026-10-01" && to! >= "2026-10-01";
    });
    expect(october).toHaveLength(2);
    expect(october[0]).not.toHaveProperty("pageToken");
    expect(typeof october[1]!.pageToken).toBe("string");
    expect(october[1]!.query).toBe(october[0]!.query);
    expect(batches.flatMap((b) => b.events)).toHaveLength(7);
    expect(batches).toHaveLength(25);
  });

  it("reads again from two weeks before the last day it read, storing revised rows as new versions", async () => {
    const data = account();
    const mock = googleAdsDocMock(data);
    const { memory, pipeline } = testPipeline();
    let now = new Date("2026-10-04T12:00:00Z");
    const c = connector(mock, { now: () => now });
    await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["2026-09-20..2026-10-04"]);
    mock.searches.length = 0;
    // A conversion is attributed late to one row; nothing else changes.
    data.rows[1]!.conversions = 3;
    now = new Date("2026-10-06T12:00:00Z");
    const report = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(ranges(mock)).toEqual(["2026-09-20..2026-10-06"]);
    expect(report.ingested).toBe(1);
    expect(report.duplicates).toBe(5);
    expect(GOOGLE_ADS_REVISIT_DAYS).toBe(14);
  });

  it("starts an incremental sync with no checkpoint two weeks back, and reads a long gap in windows", async () => {
    const mock = googleAdsDocMock(account());
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(ranges(mock)).toEqual(["2026-10-06..2026-10-20"]);
    mock.searches.length = 0;
    const old: GoogleAdsCursor = { pass: "incremental", done: true, from: "2026-07-01", until: "2026-08-01", windowStart: "2026-07-01", pageToken: null };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(old) }));
    expect(ranges(mock)).toEqual(["2026-07-18..2026-08-17", "2026-08-18..2026-09-17", "2026-09-18..2026-10-18", "2026-10-19..2026-10-20"]);
  });

  it("never starts an incremental pass after today, even from a checkpoint ahead of the clock", async () => {
    const mock = googleAdsDocMock(account());
    const ahead: GoogleAdsCursor = { pass: "incremental", done: true, from: "2026-11-01", until: "2026-12-31", windowStart: "2026-11-01", pageToken: null };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ahead) }));
    expect(ranges(mock)).toEqual(["2026-10-20..2026-10-20"]);
  });

  it("resumes an unfinished pass from its checkpoint and page, and keeps a finished import finished", async () => {
    const mock = googleAdsDocMock(account({ pageCap: 4 }));
    const early = { now: () => new Date("2026-10-04T12:00:00Z") };
    const first = await drain(connector(mock, early).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const mid = parseGoogleAdsCursor(first[0]!.cursor)!;
    expect(mid.pageToken).toEqual(expect.any(String));
    mock.searches.length = 0;
    const rest = await drain(connector(mock, early).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(mock.searches.map((s) => s.pageToken)).toEqual([mid.pageToken]);
    expect(rest.flatMap((b) => b.events)).toHaveLength(2);
    mock.searches.length = 0;
    const done: GoogleAdsCursor = { pass: "historical", done: true, from: "2024-10-20", until: "2026-10-20", windowStart: "2024-10-20", pageToken: null };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.searches).toEqual([]);
    // An interrupted import picks up where it stopped, not two years back.
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, done: false, windowStart: "2026-10-01" }) }));
    expect(ranges(mock)).toEqual(["2026-10-01..2026-10-20", "2026-10-01..2026-10-20"]);
    mock.searches.length = 0;
    // An incremental sync after a finished import reads from two weeks before its last day.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, until: "2026-10-15" }) }));
    expect(ranges(mock)[0]).toBe("2026-10-01..2026-10-20");
  });

  it("dead-letters a row with an unreadable day and stores the rest", async () => {
    const rows = [{ customer: {}, campaign: { id: "1" }, segments: { date: "nope" }, metrics: {} }, row()];
    const client = { customerId: CUSTOMER, search: async () => ({ results: rows }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(googleAdsDocMock(account()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([report.ingested, report.deadLettered]).toEqual([1, 1]);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseGoogleAdsCursor(null)).toBeNull();
    const ok: GoogleAdsCursor = { pass: "historical", done: false, from: "2024-10-20", until: "2026-10-20", windowStart: "2025-01-01", pageToken: null };
    expect(parseGoogleAdsCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parseGoogleAdsCursor(JSON.stringify({ ...ok, pageToken: "abc" }))!.pageToken).toBe("abc");
    const bad: unknown[] = [
      null,
      {},
      { ...ok, pass: "full" },
      { ...ok, done: "no" },
      { ...ok, from: "2024-13-01" },
      { ...ok, until: undefined },
      { ...ok, from: "2026-10-21" },
      { ...ok, from: "2026-10-21", windowStart: "2026-10-21" },
      { ...ok, windowStart: "2024-10-19" },
      { ...ok, windowStart: "2026-10-21" },
      { ...ok, pageToken: 5 },
      { ...ok, pageToken: undefined },
    ];
    for (const c of bad) expect(() => parseGoogleAdsCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares pausing a campaign and changing a budget, each needing approval, and a read-only gate turns both down", async () => {
    const c = connector(googleAdsDocMock(account()));
    expect(c.source).toBe("google_ads");
    expect(c.writes).toBe(GOOGLE_ADS_WRITES);
    expect(GOOGLE_ADS_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["pause_campaign", "update", "each", 5],
      ["set_campaign_budget", "update", "each", 5],
    ]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["google_ads", "pause_campaign", "refused"],
      ["google_ads", "set_campaign_budget", "refused"],
    ]);
  });

  it("lets a write through only where the instance turned it on, by name", async () => {
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["google_ads:pause_campaign"]), audit });
    const ran: string[] = [];
    for (const action of GOOGLE_ADS_WRITES) await gate.run(action, "test", async () => void ran.push(action.name)).catch(() => {});
    expect(ran).toEqual(["pause_campaign"]);
    expect(audit.entries.map((a) => a.outcome)).toEqual(["performed", "refused"]);
  });

  it("never asks Google Ads for anything but the fixed report, and never sends a mutate", async () => {
    const mock = googleAdsDocMock(account({ pageCap: 4 }));
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    for (const s of mock.searches) {
      expect(Object.keys(s).filter((k) => k !== "pageToken")).toEqual(["query"]);
      expect(String(s.query).startsWith(`SELECT ${GOOGLE_ADS_FIELDS.join(", ")} FROM campaign WHERE segments.date BETWEEN '`)).toBe(true);
    }
    expect(mock.mutations).toBe(0);
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url}`))).toEqual(new Set(["POST https://oauth2.googleapis.com/token", `POST ${SEARCH_URL}`]));
  });
});

describe("the Google Ads mock", () => {
  it("turns down a query it doesn't know, a page token from another query, and an unknown method", async () => {
    const mock = googleAdsDocMock(account({ pageCap: 2 }));
    const token = (await googleAdsClient(base(mock.fetch)).search(Q)).nextPageToken as string;
    const post = (url: string, body: unknown) =>
      mock.fetch(url, { method: "POST", headers: { authorization: "Bearer AT-TEST-1", "developer-token": DEV_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post(SEARCH_URL, { query: "SELECT campaign.id FROM ad_group" })).status).toBe(400);
    expect((await post(SEARCH_URL, { query: "SELECT customer.email FROM campaign WHERE segments.date BETWEEN '2026-10-01' AND '2026-10-02' ORDER BY segments.date, campaign.id" })).status).toBe(400);
    const other = googleAdsSearchBody({ ...Q, endDate: "2026-10-01" });
    expect((await post(SEARCH_URL, { ...other, pageToken: token })).status).toBe(400);
    expect((await post(SEARCH_URL.replace("search", "searchStream"), {})).status).toBe(404);
    expect((await post(SEARCH_URL.replace("search", "mutate"), { mutateOperations: [] })).status).toBe(200);
    expect(mock.mutations).toBe(1);
  });
});
