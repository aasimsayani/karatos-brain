import { describe, expect, it } from "vitest";
import { runSync, writePolicy, InMemoryWriteAuditLog, WriteGate, type SourceBatch } from "@karatos/core";
import { PINTEREST_MOCK_READ_SCOPES, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, pinterestDocMock, pinterestPin, testPipeline, type PinterestMock, type PinterestMockData } from "@karatos/connector-testkit";
import {
  PINTEREST_EVENTS,
  PINTEREST_METRICS,
  PINTEREST_READ_SCOPES,
  PINTEREST_REVISIT_DAYS,
  PINTEREST_TOP_PIN_DAYS,
  PINTEREST_WRITES,
  PinterestApiError,
  PinterestConfigError,
  PinterestShapeError,
  memoryTokenStore,
  parsePinterestCursor,
  pinterestAccountEvents,
  pinterestAnalyticsParams,
  pinterestClient,
  pinterestConnector,
  pinterestCount,
  pinterestDay,
  pinterestDayMs,
  pinterestLabel,
  pinterestLink,
  pinterestPinEvent,
  pinterestPinPage,
  pinterestPinsParams,
  pinterestScopeProblem,
  pinterestTopPinEvents,
  type PinterestClientOptions,
  type PinterestConnectorOptions,
  type PinterestCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = "1234567";
const CLIENT_SECRET = "s".repeat(40);
const REFRESH = `pinr.${"r".repeat(60)}`;
const TODAY = "2026-10-31";
const NOW = () => new Date(`${TODAY}T14:00:00.000Z`);
const RECEIVED = `${TODAY}T14:00:00.000Z`;
const CTX = { receivedAt: RECEIVED };
const API = "https://api.pinterest.com/v5";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const R = { startDate: "2026-10-01", endDate: "2026-10-30" };
const SCOPES = PINTEREST_MOCK_READ_SCOPES.join(",");

const dayBefore = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

function account(overrides: Partial<PinterestMockData> = {}): PinterestMockData {
  pinterestPin.reset();
  const pins = pinterestPin.many(5);
  // A metric row for each of the last 120 days, so the mock holds more than Pinterest serves.
  const daily = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [dayBefore(i), { IMPRESSION: 1000 + i, SAVE: 10 + (i % 7), PIN_CLICK: 40, OUTBOUND_CLICK: 12, ENGAGEMENT: 70, SAVE_RATE: 0.01 }]));
  const pinTotals = Object.fromEntries(pins.map((p, i) => [p.id, { SAVE: [5, 50, 20, 0, 9][i]!, IMPRESSION: 100 * (i + 1), PIN_CLICK: 3, OUTBOUND_CLICK: 1, ENGAGEMENT: 8 }]));
  return { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, today: TODAY, pins, daily, pinTotals, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch, refresh = REFRESH): PinterestClientOptions => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tokens: memoryTokenStore(refresh), sleep: noSleep, ...(fetch ? { fetch } : {}) });

/** Each mock account's refresh token store, shared by every connector built for it, as the instance's database is. */
const stores = new WeakMap<PinterestMock, ReturnType<typeof memoryTokenStore>>();

function connector(mock: PinterestMock, overrides: Partial<PinterestConnectorOptions> = {}) {
  if (!stores.has(mock)) stores.set(mock, memoryTokenStore(REFRESH));
  return pinterestConnector({ ...base(mock.fetch), tokens: stores.get(mock)!, now: NOW, ...overrides });
}

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const paths = (mock: PinterestMock) => mock.reads.map((r) => r.path);
const range = (mock: PinterestMock, path: string) => mock.reads.filter((r) => r.path === path).map((r) => `${r.query.get("start_date")}..${r.query.get("end_date")}`);
/** A fetch that refreshes with the given scope, then answers every API call with `api`. */
const fake = (api: () => Response, scope = SCOPES) =>
  (async (input: string | URL | Request) => (String(input).includes("/oauth/") ? new Response(JSON.stringify({ access_token: "AT", expires_in: 3600, scope }), { status: 200 }) : api())) as typeof fetch;

describe("Pinterest normalizer", () => {
  it("reads days, counts, titles and links, turning down anything else", () => {
    expect(pinterestDay("2026-10-01")).toBe("2026-10-01");
    expect(["2026-02-30", "2026-10-1", 20261001, undefined].map(pinterestDay)).toEqual([undefined, undefined, undefined, undefined]);
    expect([0, 12, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 2].map(pinterestCount)).toEqual([0, 12, undefined, undefined, undefined, undefined]);
    expect(pinterestLabel(`  ${"x".repeat(120)} `)).toBe("x".repeat(100));
    expect([" ", "Ask me@shop", 5].map((v) => pinterestLabel(v))).toEqual([undefined, undefined, undefined]);
    expect(pinterestLink("https://shop.example.test/products/ring-1?utm_source=pin&ref=a@b#top")).toBe("https://shop.example.test/products/ring-1");
    expect(pinterestLink("http://shop.example.test")).toBe("http://shop.example.test/");
    expect(pinterestLink(`https://shop.example.test/${"p".repeat(600)}`)).toHaveLength(500);
    expect(["javascript:alert(1)", "mailto:a@shop.example.test", "not a url", `https://x.test/${"p".repeat(2048)}`, null].map(pinterestLink)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("reads a page of Pins and its bookmark, and throws on items that aren't a list", () => {
    expect(pinterestPinPage({ items: [{ id: "1" }, "x"], bookmark: "abc" })).toEqual({ pins: [{ id: "1" }, {}], bookmark: "abc" });
    expect(pinterestPinPage({ items: [], bookmark: null }).bookmark).toBeUndefined();
    expect(pinterestPinPage({ items: [], bookmark: "" }).bookmark).toBeUndefined();
    for (const bad of [null, [], {}, { items: {} }]) expect(() => pinterestPinPage(bad), JSON.stringify(bad)).toThrow(PinterestShapeError);
  });

  it("turns a Pin into social.pin_updated with its title, link, board and metrics, and no description", () => {
    pinterestPin.reset();
    const e = pinterestPinEvent(pinterestPin.one(), CTX)!;
    expect(e).toMatchObject({ type: PINTEREST_EVENTS.pin, occurredAt: "2026-01-02T12:00:00.000Z", receivedAt: RECEIVED });
    expect(e.payload).toEqual({
      pinId: "pinterest:pin:1000000000000001",
      createdAt: "2026-01-02T12:00:00.000Z",
      title: "Test oval halo ring 1",
      link: "https://shop.example.test/products/test-ring-1",
      boardId: "pinterest:board:500001",
      isProduct: false,
      creativeType: "REGULAR",
      metrics90Days: { pin_click: 7, impression: 100, clickthrough: 3 },
      lifetimeMetrics: { pin_click: 9, impression: 150, clickthrough: 4, reaction: 1, comment: 0 },
    });
    const text = JSON.stringify(e);
    for (const leak of ["Test description", "test_store", "utm_source", "#6E7874"]) expect(text, leak).not.toContain(leak);
    expect(e.idempotencyKey).toMatch(/^pinterest:pin:1000000000000001:[0-9a-f]{16}$/);
  });

  it("keys a Pin by its numbers, so a changed Pin is a new version and an unchanged one is the same", () => {
    pinterestPin.reset();
    const pin = pinterestPin.one();
    const a = pinterestPinEvent(pin, CTX)!;
    expect(pinterestPinEvent({ ...pin }, { receivedAt: "2026-11-01T00:00:00.000Z" })!.idempotencyKey).toBe(a.idempotencyKey);
    expect(pinterestPinEvent({ ...pin, pin_metrics: { "90d": { pin_click: 8 } } }, CTX)!.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("drops what it can't trust in a Pin, skips one without an id, and leaves an unreadable time out", () => {
    expect(pinterestPinEvent({ id: "abc" }, CTX)).toBeNull();
    expect(pinterestPinEvent({ id: "1".repeat(26) }, CTX)).toBeNull();
    expect(pinterestPinEvent(null as never, CTX)).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${String.fromCharCode(97 + i)}`, i]));
    const e = pinterestPinEvent({ id: "7", created_at: "soon", board_id: "x", is_product: "yes", creative_type: "video", pin_metrics: { "90d": { pin_click: -1, Impression: 3, clickthrough: 1.5 }, lifetime_metrics: many } }, CTX)!;
    expect(e.occurredAt).toBeUndefined();
    expect(e.payload).toEqual({ pinId: "pinterest:pin:7", lifetimeMetrics: Object.fromEntries(Object.entries(many).slice(0, 20)) });
  });

  it("turns the account's daily metrics into social.account_reported, one per day", () => {
    const body = { all: { daily_metrics: [{ date: "2026-10-30", data_status: "READY", metrics: { IMPRESSION: 240, SAVE: 20, PIN_CLICK: 37, OUTBOUND_CLICK: 20, ENGAGEMENT: 41, SAVE_RATE: 0.18 } }, { date: "nope", data_status: "processing", metrics: { SAVE: 1.5 } }] }, summary_metrics: {} };
    const [a, b] = pinterestAccountEvents(body, CTX);
    expect(a).toMatchObject({ type: PINTEREST_EVENTS.account, occurredAt: "2026-10-30T00:00:00.000Z", payload: { day: "2026-10-30", dataStatus: "READY", impressions: 240, saves: 20, pinClicks: 37, outboundClicks: 20, engagements: 41 } });
    expect(a!.idempotencyKey).toMatch(/^pinterest:account:2026-10-30:[0-9a-f]{16}$/);
    expect(b).toMatchObject({ occurredAt: undefined, payload: {} });
    expect(b!.idempotencyKey).toMatch(/^pinterest:account:unknown:/);
    expect(pinterestAccountEvents({}, CTX)).toEqual([]);
    for (const bad of [{ all: {} }, { all: { daily_metrics: {} } }, { all: "x" }]) expect(() => pinterestAccountEvents(bad, CTX), JSON.stringify(bad)).toThrow(PinterestShapeError);
  });

  it("ranks the most saved Pins as social.top_pin_reported, keyed by the range's end", () => {
    const body = { pins: [{ pin_id: "22", metrics: { SAVE: 50, IMPRESSION: 900 } }, { pin_id: "bad" }, { pin_id: "11", metrics: { SAVE: 9 } }], sort_by: "SAVE" };
    const events = pinterestTopPinEvents(body, R, CTX);
    expect(events.map((e) => e.payload)).toEqual([
      { pinId: "pinterest:pin:22", rank: 1, from: "2026-10-01", until: "2026-10-30", rankedBy: "SAVE", impressions: 900, saves: 50 },
      { pinId: "pinterest:pin:11", rank: 3, from: "2026-10-01", until: "2026-10-30", rankedBy: "SAVE", saves: 9 },
    ]);
    expect(events[0]).toMatchObject({ type: PINTEREST_EVENTS.topPin, occurredAt: "2026-10-30T00:00:00.000Z" });
    expect(events[0]!.idempotencyKey).toMatch(/^pinterest:top:2026-10-30:22:[0-9a-f]{16}$/);
    expect(pinterestTopPinEvents({}, R, CTX)).toEqual([]);
    expect(pinterestTopPinEvents(body, { startDate: "x", endDate: "y" }, CTX)[0]).toMatchObject({ occurredAt: undefined, idempotencyKey: expect.stringMatching(/^pinterest:top:unknown:22:/) });
    for (const bad of [{ pins: {} }, { pins: null }]) expect(() => pinterestTopPinEvents(bad, R, CTX)).toThrow(PinterestShapeError);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Pinterest client", () => {
  it("builds analytics and Pin list queries only from a checked range, the fixed metrics and Pinterest's bookmark", () => {
    expect(Object.fromEntries(pinterestAnalyticsParams(R))).toEqual({ start_date: "2026-10-01", end_date: "2026-10-30", metric_types: PINTEREST_METRICS.join(",") });
    expect(Object.fromEntries(pinterestAnalyticsParams(R, true))).toEqual({ start_date: "2026-10-01", end_date: "2026-10-30", metric_types: "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,ENGAGEMENT", sort_by: "SAVE", num_of_pins: "50" });
    expect(pinterestAnalyticsParams({ startDate: "2026-08-03", endDate: "2026-10-31" }).get("start_date")).toBe("2026-08-03");
    for (const bad of [{ ...R, ad_account_id: "1" }, { ...R, startDate: "2026-10-1" }, { ...R, endDate: "2026-02-30" }, { startDate: "2026-09-31", endDate: "2026-10-02" }, { startDate: "2026-10-02", endDate: "2026-10-01" }, { startDate: "2026-08-02", endDate: "2026-10-31" }]) {
      expect(() => pinterestAnalyticsParams(bad as never), JSON.stringify(bad)).toThrow(PinterestConfigError);
    }
    expect(Object.fromEntries(pinterestPinsParams(null))).toEqual({ page_size: "250", pin_metrics: "true" });
    expect(pinterestPinsParams("abc=").get("bookmark")).toBe("abc=");
    for (const bad of ["", "a&b=c", "x".repeat(2049), 5]) expect(() => pinterestPinsParams(bad as never), String(bad)).toThrow(PinterestConfigError);
  });

  it("accepts the three read scopes, comma or space separated, and nothing more or less", () => {
    expect(pinterestScopeProblem("boards:read,pins:read,user_accounts:read")).toBeNull();
    expect(pinterestScopeProblem("user_accounts:read pins:read  boards:read")).toBeNull();
    expect(pinterestScopeProblem("boards:read,pins:read,user_accounts:read,pins:write")).toBe("the Pinterest connection holds more than read access (pins:write)");
    expect(pinterestScopeProblem("boards:read,pins:read")).toBe("the Pinterest connection doesn't hold user_accounts:read");
    expect(pinterestScopeProblem(`${"x".repeat(2048)},pins:read`)).toMatch(/^the Pinterest connection holds more than read access \(x{200}\)$/);
    for (const none of [undefined, "", "  ", 5]) expect(pinterestScopeProblem(none)).toBe("Pinterest didn't say which scopes the token holds");
    expect(PINTEREST_READ_SCOPES).toEqual(["boards:read", "pins:read", "user_accounts:read"]);
  });

  it("won't build without the app's id and secret", () => {
    expect(() => pinterestClient({ ...base(), clientId: "" })).toThrow("set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET");
    expect(() => pinterestClient({ ...base(), clientSecret: "has space" })).toThrow("set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET");
    expect(() => pinterestClient({ ...base(), clientSecret: "x".repeat(513) })).toThrow("set PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET");
    expect(() => pinterestClient({ ...base(), clientId: ` ${CLIENT_ID} ` })).not.toThrow();
  });

  it("refreshes once with Basic credentials, saves the new refresh token, and sends only GETs with the token in a header", async () => {
    const mock = pinterestDocMock(account());
    const tokens = memoryTokenStore(REFRESH);
    const client = pinterestClient({ ...base(mock.fetch), tokens });
    await client.pins(null);
    await client.accountAnalytics(R);
    await client.topPins(R);
    expect(mock.refreshes).toBe(1);
    expect(tokens.current).toBe("pinr_TEST1");
    expect(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([`POST ${API}/oauth/token`, `GET ${API}/pins`, `GET ${API}/user_account/analytics`, `GET ${API}/user_account/analytics/top_pins`]);
    expect(mock.fetch.calls.every((c) => !c.url.includes("pina_") && !c.url.includes(REFRESH))).toBe(true);
  });

  it("renews the access token once on a 401 with the saved refresh token, and gives up on a second", async () => {
    const mock = pinterestDocMock(account());
    const tokens = memoryTokenStore(REFRESH);
    const client = pinterestClient({ ...base(mock.fetch), tokens });
    await client.pins(null);
    mock.revokeAccessTokens();
    await client.pins(null);
    expect(mock.refreshes).toBe(2);
    expect(tokens.current).toBe("pinr_TEST2");
    let calls = 0;
    const always401 = fake(() => (calls++, new Response(JSON.stringify({ code: 2, message: "Authentication failed." }), { status: 401 })));
    const error = await pinterestClient(base(always401)).pins(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PinterestApiError);
    expect(error).toMatchObject({ status: 401, code: 2, message: "Pinterest answered HTTP 401: Authentication failed." });
    expect(calls).toBe(2);
  });

  it("stops when the token holds more than the read scopes, before reading anything, keeping the new refresh token", async () => {
    const mock = pinterestDocMock(account({ scopes: [...PINTEREST_MOCK_READ_SCOPES, "pins:write"] }));
    const tokens = memoryTokenStore(REFRESH);
    await expect(pinterestClient({ ...base(mock.fetch), tokens }).pins(null)).rejects.toThrow("the Pinterest connection holds more than read access (pins:write); connect it again with only boards:read, pins:read, user_accounts:read");
    expect(mock.reads).toEqual([]);
    expect(tokens.current).toBe("pinr_TEST1");
  });

  it("explains a replaced refresh token, wrong app keys, a missing token and a failed refresh", async () => {
    const reason = (data: Partial<PinterestMockData>, refresh = REFRESH) => pinterestClient(base(pinterestDocMock(account(data)).fetch, refresh)).pins(null).catch((e: unknown) => e as PinterestApiError);
    expect(await reason({}, `${REFRESH}x`)).toMatchObject({ status: 400, code: 1, message: "Pinterest turned down the token refresh (HTTP 400: Invalid refresh token.); the refresh token expired or was revoked, so connect the Pinterest account again" });
    expect(await reason({ clientSecret: "t".repeat(40) })).toMatchObject({ status: 401, message: "Pinterest turned down the token refresh (HTTP 401: Authentication failed.); check PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET" });
    expect(await reason({}, " ")).toMatchObject({ message: "set PINTEREST_REFRESH_TOKEN" });
    const odd = (body: unknown, status = 200) => pinterestClient(base((async () => new Response(JSON.stringify(body), { status })) as typeof fetch)).pins(null).catch((e: unknown) => e as PinterestApiError);
    expect(await odd({ code: 99, message: "m".repeat(300) }, 503)).toMatchObject({ code: 99, message: `Pinterest turned down the token refresh (HTTP 503: ${"m".repeat(200)})` });
    expect(await odd({ access_token: "" })).toMatchObject({ message: "Pinterest turned down the token refresh (HTTP 200)" });
    expect(await odd({ code: 1.5 }, 500)).toMatchObject({ code: undefined, message: "Pinterest turned down the token refresh (HTTP 500)" });
    expect(await odd({ access_token: "AT", scope: SCOPES, refresh_token: "" }).then(() => "ok")).toBe("ok");
  });

  it("uses the access token for its lifetime, less two minutes, then refreshes", async () => {
    let now = 0;
    let refreshes = 0;
    let lifetime: unknown = 600;
    const counting = (async (input: string | URL | Request) => {
      if (String(input).includes("/oauth/")) return (refreshes++, new Response(JSON.stringify({ access_token: `AT${refreshes}`, expires_in: lifetime, scope: SCOPES }), { status: 200 }));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    const client = pinterestClient({ ...base(counting), clock: () => now });
    await client.pins(null);
    now = 479_000;
    await client.pins(null);
    expect(refreshes).toBe(1);
    now = 480_000;
    lifetime = "soon";
    await client.pins(null);
    expect(refreshes).toBe(2);
    // Without a usable lifetime, an hour, less two minutes.
    now += 3_479_000;
    await client.pins(null);
    expect(refreshes).toBe(2);
    now += 1000;
    lifetime = -5;
    await client.pins(null);
    expect(refreshes).toBe(3);
    await client.pins(null);
    expect(refreshes).toBe(3);
  });

  it("refreshes once for reads sent together", async () => {
    const mock = pinterestDocMock(account());
    const client = pinterestClient(base(mock.fetch));
    await Promise.all([client.pins(null), client.accountAnalytics(R), client.topPins(R)]);
    expect(mock.refreshes).toBe(1);
  });

  it("waits out a 429 a few times, honoring Retry-After up to a cap, then gives up with a clear error", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = pinterestDocMock(account({ rateLimited: 2 }));
    expect((await pinterestClient({ ...base(mock.fetch), sleep }).pins(null)).items).toHaveLength(5);
    expect(waits).toEqual([1000, 2000]);
    waits.length = 0;
    const after = ["5", "500", "0", "soon"];
    let i = 0;
    const limited = fake(() => new Response(JSON.stringify({ code: 8, message: "rate limit" }), { status: 429, headers: { "retry-after": after[i++] ?? "1" } }));
    const error = await pinterestClient({ ...base(limited), sleep, rateLimitRetries: 4 }).pins(null).catch((e: unknown) => e);
    expect(waits).toEqual([5000, 64_000, 4000, 8000]);
    expect(error).toMatchObject({ status: 429, code: 8, message: "Pinterest kept rate-limiting the sync; its limits refill within the minute, and the next sync resumes from the checkpoint" });
    waits.length = 0;
    let n = 0;
    const doubling = fake(() => (n++, new Response("{}", { status: 429 })));
    await pinterestClient({ ...base(doubling), sleep, rateLimitRetries: 8 }).pins(null).catch(() => {});
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
    expect(n).toBe(9);
    n = 0;
    await pinterestClient(base(doubling)).pins(null).catch(() => {});
    expect(n).toBe(4);
  });

  it("explains a personal account, and turns down an answer that isn't a JSON object", async () => {
    const status = (code: number, body: unknown) => pinterestClient(base(fake(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code })))).accountAnalytics(R).catch((e: unknown) => e as PinterestApiError);
    expect(await status(403, { code: 29, message: "Not permitted" })).toMatchObject({ status: 403, code: 29, message: "Pinterest answered HTTP 403: Not permitted; analytics need a business account, so convert the Pinterest account to one" });
    expect(await status(500, "<html>")).toMatchObject({ message: "Pinterest answered HTTP 500" });
    for (const body of ["<html>", "[]", "null", "5"]) expect(await status(200, body)).toMatchObject({ status: 200, message: "Pinterest did not answer with JSON" });
  });

  it("checks a query before any request is sent", async () => {
    const mock = pinterestDocMock(account());
    await expect(pinterestClient(base(mock.fetch)).accountAnalytics({ startDate: "2026-10-02", endDate: "2026-10-01" })).rejects.toThrow(PinterestConfigError);
    await expect(pinterestClient(base(mock.fetch)).pins("a b")).rejects.toThrow(PinterestConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Pinterest connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(pinterestDocMock(account())), expected: { ingested: 5 + 90 + 5 } });
    expect(result.full.batches).toBe(3);
    expect(parsePinterestCursor(result.full.cursor)).toEqual({ pass: "historical", step: "done", bookmark: null, today: TODAY });
  });

  it("reads every Pin, then 90 days of account metrics, then the top Pins of the last 30 days", async () => {
    const mock = pinterestDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(100);
    expect(paths(mock)).toEqual(["/pins", "/user_account/analytics", "/user_account/analytics/top_pins"]);
    expect(range(mock, "/user_account/analytics")).toEqual(["2026-08-03..2026-10-31"]);
    expect(range(mock, "/user_account/analytics/top_pins")).toEqual(["2026-10-02..2026-10-31"]);
    const top = memory.events.filter((e) => e.type === PINTEREST_EVENTS.topPin).map((e) => [e.payload.rank, e.payload.saves]);
    expect(top).toEqual([[1, 50], [2, 20], [3, 9], [4, 5], [5, 0]]);
    expect(memory.events.every((e) => e.source === "pinterest")).toBe(true);
    expect(PINTEREST_TOP_PIN_DAYS).toBe(30);
  });

  it("pages through the Pins with Pinterest's bookmark", async () => {
    const mock = pinterestDocMock(account({ pageCap: 2 }));
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const pinReads = mock.reads.filter((r) => r.path === "/pins");
    expect(pinReads.map((r) => r.query.has("bookmark"))).toEqual([false, true, true]);
    expect(batches).toHaveLength(5);
    expect(batches.slice(0, 3).flatMap((b) => b.events)).toHaveLength(5);
    expect(parsePinterestCursor(batches[0]!.cursor)!.bookmark).toEqual(expect.any(String));
    expect(parsePinterestCursor(batches[2]!.cursor)).toMatchObject({ step: "account", bookmark: null });
  });

  it("reads the last 30 days again on each sync, storing a changed day or Pin as a new version", async () => {
    const data = account();
    const mock = pinterestDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    mock.reads.length = 0;
    // Yesterday's saves are revised and one Pin is retitled; nothing else changes.
    data.daily[dayBefore(1)]!.SAVE = 99;
    data.pins[0] = { ...data.pins[0]!, title: "Test oval halo ring, renamed" };
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(range(mock, "/user_account/analytics")).toEqual(["2026-10-02..2026-10-31"]);
    expect([report.ingested, report.duplicates]).toEqual([2, 4 + 29 + 5]);
    expect(PINTEREST_REVISIT_DAYS).toBe(30);
  });

  it("resumes an unfinished pass from its step and bookmark, and keeps a finished import finished", async () => {
    const mock = pinterestDocMock(account({ pageCap: 2 }));
    const first = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const mid = parsePinterestCursor(first[0]!.cursor)!;
    mock.reads.length = 0;
    const rest = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(mock.reads[0]!.query.get("bookmark")).toBe(mid.bookmark);
    expect(rest).toHaveLength(4);
    mock.reads.length = 0;
    const done: PinterestCursor = { pass: "historical", step: "done", bookmark: null, today: "2026-10-01" };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.reads).toEqual([]);
    // An interrupted import picks up at its step, on the day it started.
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, step: "account", today: "2026-10-30" }) }));
    expect(paths(mock)).toEqual(["/user_account/analytics", "/user_account/analytics/top_pins"]);
    expect(range(mock, "/user_account/analytics")).toEqual(["2026-08-02..2026-10-30"]);
    mock.reads.length = 0;
    // An incremental sync after a finished pass starts a new one today, from the Pins.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, pass: "incremental" }) }));
    expect(paths(mock)[0]).toBe("/pins");
    expect(range(mock, "/user_account/analytics")).toEqual(["2026-10-02..2026-10-31"]);
  });

  it("dead-letters a day with an unreadable date and stores the rest", async () => {
    const client = {
      pins: async () => ({ items: [] }),
      accountAnalytics: async () => ({ all: { daily_metrics: [{ date: "nope", metrics: {} }, { date: "2026-10-30", metrics: { SAVE: 1 } }] } }),
      topPins: async () => ({ pins: [] }),
    };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(pinterestDocMock(account()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([report.ingested, report.deadLettered]).toEqual([1, 1]);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parsePinterestCursor(null)).toBeNull();
    const ok: PinterestCursor = { pass: "historical", step: "pins", bookmark: "abc", today: TODAY };
    expect(parsePinterestCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parsePinterestCursor(JSON.stringify({ ...ok, step: "top_pins", bookmark: null }))!.step).toBe("top_pins");
    const bad: unknown[] = [null, {}, { ...ok, pass: "full" }, { ...ok, step: "boards", bookmark: null }, { ...ok, bookmark: 5 }, { ...ok, bookmark: undefined }, { ...ok, step: "account" }, { ...ok, today: "2026-13-01" }, { ...ok, today: undefined }];
    for (const c of bad) expect(() => parsePinterestCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares creating a Pin, needing approval, and a read-only gate turns it down", async () => {
    const c = connector(pinterestDocMock(account()));
    expect(c.source).toBe("pinterest");
    expect(c.writes).toBe(PINTEREST_WRITES);
    expect(PINTEREST_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([["create_pin", "append", "each", 10]]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([["pinterest", "create_pin", "refused"]]);
  });

  it("lets a write through only where the instance turned it on, by name", async () => {
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["pinterest:create_pin"]), audit });
    const ran: string[] = [];
    for (const action of PINTEREST_WRITES) await gate.run(action, "test", async () => void ran.push(action.name));
    expect(ran).toEqual(["create_pin"]);
    expect(audit.entries.map((a) => a.outcome)).toEqual(["performed"]);
  });

  it("never asks Pinterest for anything but its three reads, and never creates a Pin", async () => {
    const mock = pinterestDocMock(account({ pageCap: 2 }));
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    for (const r of mock.reads) {
      const keys = [...r.query.keys()].sort();
      if (r.path === "/pins") expect(keys.filter((k) => k !== "bookmark")).toEqual(["page_size", "pin_metrics"]);
      else expect(keys).toEqual(r.path === "/user_account/analytics" ? ["end_date", "metric_types", "start_date"] : ["end_date", "metric_types", "num_of_pins", "sort_by", "start_date"]);
    }
    expect(mock.writes).toBe(0);
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`))).toEqual(new Set([`POST ${API}/oauth/token`, `GET ${API}/pins`, `GET ${API}/user_account/analytics`, `GET ${API}/user_account/analytics/top_pins`]));
  });
});

describe("the Pinterest mock", () => {
  it("turns down a range past 90 days back, a bad page size or sort, a bookmark from another list, and a Pin from a read-only token", async () => {
    const mock = pinterestDocMock(account({ pageCap: 2 }));
    const bookmark = (await pinterestClient(base(mock.fetch)).pins(null)).bookmark as string;
    const auth = { authorization: "Bearer pina_TEST1" };
    const get = (path: string) => mock.fetch(`${API}${path}`, { headers: auth }).then((r) => r.status);
    expect(await get(`/user_account/analytics?start_date=${dayBefore(91)}&end_date=${TODAY}`)).toBe(400);
    expect(await get(`/user_account/analytics?start_date=${TODAY}&end_date=${dayBefore(1)}`)).toBe(400);
    expect(await get(`/user_account/analytics?start_date=${TODAY}&end_date=${TODAY}&metric_types=CLOSEUP`)).toBe(400);
    expect(await get(`/user_account/analytics/top_pins?start_date=${TODAY}&end_date=${TODAY}&sort_by=CLOSEUP`)).toBe(400);
    expect(await get(`/user_account/analytics/top_pins?start_date=${TODAY}&end_date=${TODAY}&sort_by=SAVE&num_of_pins=51`)).toBe(400);
    expect(await get("/pins?page_size=251")).toBe(400);
    expect(await get(`/pins?page_size=10&bookmark=${bookmark}`)).toBe(400);
    expect(await get(`/user_account/analytics?start_date=${TODAY}&end_date=${TODAY}`)).toBe(200);
    const create = await mock.fetch(`${API}/pins`, { method: "POST", headers: auth, body: "{}" });
    expect(create.status).toBe(403);
    expect(mock.writes).toBe(1);
    expect(pinterestDayMs("2026-10-31")).toBe(Date.parse("2026-10-31T00:00:00Z"));
  });
});
