import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  DOC_MOCK_MODULES,
  TEST_ORG,
  UndocumentedRequestError,
  WATCHTRADERHUB_DOC_PAGES,
  assertSynthetic,
  checkConnectorSync,
  testPipeline,
  watchTraderHubDocMock,
  watchTraderHubListing,
  watchTraderHubOrder,
  watchTraderHubPart,
  type WatchTraderHubMock,
  type WatchTraderHubMockData,
  type WatchTraderHubMockRecord,
} from "@karatos/connector-testkit";
import {
  WATCHTRADERHUB_API_BASE,
  WATCHTRADERHUB_FIRST_WINDOW_DAYS,
  WATCHTRADERHUB_OVERLAP_MINUTES,
  WATCHTRADERHUB_PAGE_SIZE,
  WATCHTRADERHUB_USER_AGENT,
  WATCHTRADERHUB_WRITES,
  WatchTraderHubApiError,
  WatchTraderHubConfigError,
  isWatchTraderHubCursor,
  isWatchTraderHubSince,
  parseWatchTraderHubCursor,
  watchTraderHubCents,
  watchTraderHubClient,
  watchTraderHubConnector,
  watchTraderHubCurrency,
  watchTraderHubId,
  watchTraderHubListingEvents,
  watchTraderHubOrderEvents,
  watchTraderHubPartEvents,
  watchTraderHubPrice,
  watchTraderHubQuantity,
  watchTraderHubSku,
  watchTraderHubTime,
  type WatchTraderHubClient,
  type WatchTraderHubCursor,
  type WatchTraderHubEvent,
  type WatchTraderHubOptions,
} from "../src/index.js";

// Key-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["wth", "a".repeat(32)].join("_");
const OTHER_KEY = ["wth", "b".repeat(32)].join("_");
const MIXED_KEY = ["wth", `${"Ab3".repeat(10)}Zz`].join("_");
const BEARER = `Bearer ${KEY}`;
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
const HEADERS = { accept: "application/json", authorization: BEARER, "user-agent": WATCHTRADERHUB_USER_AGENT };
const noSleep = async () => {};
const minutes = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 60_000).toISOString();
const daysAgo = (n: number) => new Date(Date.parse(RECEIVED) - n * 86_400_000).toISOString();
const LISTING_1 = "24f0ebb1-0000-4000-a000-a00000000001";
const PART_1 = "7a11c0de-0000-4000-a000-a00000000001";
const ORDER_1 = "d7df4fbe-0000-4000-a000-a00000000001";

const reset = () => {
  for (const b of [watchTraderHubListing, watchTraderHubPart, watchTraderHubOrder]) b.reset();
};
/** Three listings, two parts and two orders. */
function account(overrides: Partial<WatchTraderHubMockData> = {}): WatchTraderHubMockData {
  reset();
  return { key: KEY, listings: watchTraderHubListing.many(3), parts: watchTraderHubPart.many(2), orders: watchTraderHubOrder.many(2), ...overrides };
}
/** Listing 1 with overrides; its id stays LISTING_1 unless given. */
const listing = (over: WatchTraderHubMockRecord = {}) => {
  reset();
  return { ...watchTraderHubListing.one(), ...over };
};
const part = (over: WatchTraderHubMockRecord = {}) => {
  reset();
  return { ...watchTraderHubPart.one(), ...over };
};
const order = (over: WatchTraderHubMockRecord = {}) => {
  reset();
  return { ...watchTraderHubOrder.one(), ...over };
};
const connector = (mock: WatchTraderHubMock, overrides: Partial<WatchTraderHubOptions> = {}) => watchTraderHubConnector({ apiKey: KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as WatchTraderHubEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const reads = (mock: WatchTraderHubMock) => mock.reads.map((r) => `${r.path} ${r.after === null ? "first" : "next"} ${r.updatedAfter ?? "all"}`);
const cursorOf = (c: Partial<WatchTraderHubCursor>): string => JSON.stringify({ done: false, step: "listings", page: null, since: null, started: RECEIVED, ...c });

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const empty = json(200, { object: "list", data: [], has_more: false, next_cursor: null });
const error = (code: string, message = "m") => ({ error: { type: "x_error", code, message, request_id: "req_1" } });
const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => {
  const slept: number[] = [];
  const c = watchTraderHubClient({ apiKey: KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const first = { after: null, updatedAfter: null };

describe("WatchTraderHub client", () => {
  it("checks its key before sending anything", () => {
    const message = "set WATCHTRADERHUB_API_KEY to a WatchTraderHub API key, which is wth_ and 32 letters and digits";
    const bad = ["", "wth_", ["wth", "a".repeat(31)].join("_"), ["wth", "a".repeat(33)].join("_"), ["wth", `${"a".repeat(31)}-`].join("_"), ["WTH", "a".repeat(32)].join("_"), ["wth", "a".repeat(32)].join("-"), `x${KEY}`, `Bearer ${KEY}`, `${KEY} more`, undefined as unknown as string];
    for (const apiKey of bad) expect(() => watchTraderHubClient({ apiKey }), String(apiKey).slice(0, 8)).toThrow(new WatchTraderHubConfigError(message));
    for (const apiKey of [` ${KEY}\n`, ["wth", "Az09".repeat(8)].join("_")]) expect(() => watchTraderHubClient({ apiKey })).not.toThrow();
    expect(new WatchTraderHubConfigError("x").name).toBe("WatchTraderHubConfigError");
    expect(new WatchTraderHubApiError("x", 500, "internal_error")).toMatchObject({ name: "WatchTraderHubApiError", status: 500, code: "internal_error" });
  });

  it("sends only GETs of /me and the three lists, 250 a page, with the bearer key and a User-Agent", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    await c.listings(first);
    await c.listings({ after: "a+b/c=", updatedAfter: null });
    await c.parts({ after: null, updatedAfter: "2026-11-01T00:00:00.000Z" });
    await c.orders({ after: "o2", updatedAfter: "2026-11-01T00:00:00.000Z" });
    const me = scripted([json(200, { object: "integration" })]);
    await client(me.fetch, { apiKey: `  ${KEY}\n` }).c.me();
    expect([...sent, ...me.sent]).toEqual([
      { url: `${WATCHTRADERHUB_API_BASE}/listings?limit=250`, method: "GET", headers: HEADERS },
      { url: `${WATCHTRADERHUB_API_BASE}/listings?limit=250&after=a%2Bb%2Fc%3D`, method: "GET", headers: HEADERS },
      { url: `${WATCHTRADERHUB_API_BASE}/parts?limit=250&updated_after=2026-11-01T00%3A00%3A00.000Z`, method: "GET", headers: HEADERS },
      { url: `${WATCHTRADERHUB_API_BASE}/orders?limit=250&after=o2&updated_after=2026-11-01T00%3A00%3A00.000Z`, method: "GET", headers: HEADERS },
      { url: `${WATCHTRADERHUB_API_BASE}/me`, method: "GET", headers: HEADERS },
    ]);
    expect(WATCHTRADERHUB_API_BASE).toBe("https://www.watchtraderhub.com/api/v1");
    expect(WATCHTRADERHUB_PAGE_SIZE).toBe(250);
    expect(WATCHTRADERHUB_USER_AGENT).toBe("KaratOS/1.0 (+https://github.com/aasimsayani/karatos-brain)");
    expect(Object.keys(c).sort()).toEqual(["listings", "me", "orders", "parts"]);
  });

  it("turns down a cursor or time it didn't make, before sending anything", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    for (const after of ["", "c".repeat(2049), "a b", "é", 5 as unknown as string]) {
      await expect(c.listings({ after, updatedAfter: null }), String(after).slice(0, 5)).rejects.toThrow(new WatchTraderHubApiError("a cursor for the listings must be 1 to 2048 visible characters", 0));
    }
    for (const updatedAfter of ["", "2026-11-01T00:00:00Z", "2026-11-01T00:00:00.000+00:00", "2026-02-30T00:00:00.000Z", "2026-13-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", "2026-11-01", "x", 5 as unknown as string, Symbol("t") as unknown as string]) {
      await expect(c.orders({ after: null, updatedAfter }), String(updatedAfter)).rejects.toThrow(new WatchTraderHubApiError("updated_after for the orders must be an ISO time in UTC", 0));
    }
    await expect(c.parts({ after: "", updatedAfter: null })).rejects.toThrow("a cursor for the parts must be");
    expect(sent).toHaveLength(0);
    await c.listings({ after: "c".repeat(2048), updatedAfter: null });
    await c.listings({ after: "!~", updatedAfter: "2026-02-28T23:59:59.999Z" });
    expect(sent).toHaveLength(2);
    expect([isWatchTraderHubCursor("x"), isWatchTraderHubCursor(null), isWatchTraderHubSince("2026-11-01T00:00:00.000Z"), isWatchTraderHubSince(null)]).toEqual([true, false, true, false]);
    // A month that doesn't exist reads as false, never a RangeError.
    expect([isWatchTraderHubSince("2026-13-01T00:00:00.000Z"), isWatchTraderHubSince("9999-12-31T23:59:59.999Z"), isWatchTraderHubSince("0000-01-01T00:00:00.000Z")]).toEqual([false, true, true]);
  });

  it("explains a key WatchTraderHub turns down, hiding anything shaped like a key", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.listings(first);
    const must = "WATCHTRADERHUB_API_KEY must be the current key of an enabled custom integration on the dealer's Business plan";
    await expect(at(json(401, error("invalid_api_key", "The API key matches no active integration.")))).rejects.toThrow(
      new WatchTraderHubConfigError(`WatchTraderHub turned down the API key (HTTP 401) (invalid_api_key): The API key matches no active integration.; ${must}`),
    );
    await expect(at(json(403, error("integration_disabled", "Paused.")))).rejects.toThrow(new WatchTraderHubConfigError(`WatchTraderHub turned down the API key (HTTP 403) (integration_disabled): Paused.; ${must}`));
    await expect(at(json(403, error("subscription_required", "")))).rejects.toThrow(new WatchTraderHubConfigError(`WatchTraderHub turned down the API key (HTTP 403) (subscription_required); ${must}`));
    await expect(at(json(401, { error: "unauthorized" }))).rejects.toThrow(new WatchTraderHubConfigError(`WatchTraderHub turned down the API key (HTTP 401); ${must}`));
    await expect(at(() => new Response("nope", { status: 403 }))).rejects.toBeInstanceOf(WatchTraderHubConfigError);
    const echoed = await at(json(401, error("malformed_authorization", `Bad header ${KEY} and ${OTHER_KEY}`))).then(() => null, (e: unknown) => e as Error);
    expect(echoed!.message).toBe(`WatchTraderHub turned down the API key (HTTP 401) (malformed_authorization): Bad header wth_... and wth_...; ${must}`);
    expect(echoed!.message).not.toContain(KEY);
    const mixed = await at(json(401, error("malformed_authorization", `Bad header ${MIXED_KEY}`))).then(() => null, (e: unknown) => e as Error);
    expect(mixed!.message).toBe(`WatchTraderHub turned down the API key (HTTP 401) (malformed_authorization): Bad header wth_...; ${must}`);
    // A key that runs past the 200-character cut is hidden before the cut, so no part of it shows.
    const late = await at(json(401, error("malformed_authorization", `${"d".repeat(180)}${KEY}`))).then(() => null, (e: unknown) => e as Error);
    expect(late!.message).toBe(`WatchTraderHub turned down the API key (HTTP 401) (malformed_authorization): ${"d".repeat(180)}wth_...; ${must}`);
    // auth_lookup_failed is transient, so it is no config error and the sync retries it.
    await expect(at(json(401, error("auth_lookup_failed", "Try again.")))).rejects.toThrow(new WatchTraderHubApiError("WatchTraderHub answered HTTP 401 for the listings (auth_lookup_failed): Try again.", 401, "auth_lookup_failed"));
    await expect(at(json(401, error("auth_lookup_failed")))).rejects.not.toBeInstanceOf(WatchTraderHubConfigError);
    await expect(at(json(403, error("auth_lookup_failed")))).rejects.toBeInstanceOf(WatchTraderHubConfigError);
  });

  it("explains other answers, and turns down a page that doesn't read", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.orders(first);
    await expect(at(json(400, error("invalid_cursor", "d".repeat(250))))).rejects.toThrow(new WatchTraderHubApiError(`WatchTraderHub answered HTTP 400 for the orders (invalid_cursor): ${"d".repeat(200)}`, 400, "invalid_cursor"));
    await expect(at(json(404, { error: { code: "Not Found", message: "No." } }))).rejects.toMatchObject({ message: "WatchTraderHub answered HTTP 404 for the orders: No.", code: undefined });
    await expect(at(json(404, { error: { code: "c".repeat(65) } }))).rejects.toMatchObject({ code: undefined });
    await expect(at(json(400, { error: { code: ["invalid_cursor"], message: "No." } }))).rejects.toMatchObject({ message: "WatchTraderHub answered HTTP 400 for the orders: No.", code: undefined });
    await expect(at(json(400, { error: "invalid_cursor" }))).rejects.toThrow(/^WatchTraderHub answered HTTP 400 for the orders$/);
    await expect(at(json(400, { code: "invalid_cursor", message: "Not in error." }))).rejects.toMatchObject({ message: "WatchTraderHub answered HTTP 400 for the orders", code: undefined });
    await expect(at(json(400, { error: { code: "c".repeat(64), message: 5 } }))).rejects.toMatchObject({ message: `WatchTraderHub answered HTTP 400 for the orders (${"c".repeat(64)})`, code: "c".repeat(64) });
    await expect(at(json(500, null))).rejects.toThrow(/^WatchTraderHub answered HTTP 500 for the orders$/);
    await expect(at(json(500, { error: null }))).rejects.toThrow(/^WatchTraderHub answered HTTP 500 for the orders$/);
    await expect(at(json(202, {}))).rejects.toMatchObject({ status: 202 });
    const list = (over: Record<string, unknown>) => ({ object: "list", data: [], has_more: false, next_cursor: null, ...over });
    const bad = [null, [], 5, {}, list({ object: "listing" }), list({ object: undefined }), list({ data: 5 }), list({ data: {} }), list({ has_more: undefined }), list({ has_more: "false" }), list({ next_cursor: 5 }), list({ next_cursor: "", has_more: true }), list({ next_cursor: "c".repeat(2049), has_more: true }), list({ has_more: true }), list({ next_cursor: "n" })];
    for (const body of bad) await expect(at(json(200, body)), JSON.stringify(body)?.slice(0, 60)).rejects.toThrow(new WatchTraderHubApiError("WatchTraderHub answered the orders without a page that reads", 200));
    await expect(at(() => new Response("{", { status: 200 }))).rejects.toThrow("without a page that reads");
    expect(await at(json(200, list({ data: [{ id: "1" }] })))).toEqual({ data: [{ id: "1" }], nextCursor: null });
    expect(await at(json(200, { object: "list", data: [], has_more: false }))).toEqual({ data: [], nextCursor: null });
    expect(await at(json(200, list({ has_more: true, next_cursor: "n" })))).toEqual({ data: [], nextCursor: "n" });
    const same = client(scripted([json(200, list({ has_more: true, next_cursor: "c1" }))]).fetch).c;
    await expect(same.parts({ after: "c1", updatedAfter: null })).rejects.toThrow(new WatchTraderHubApiError("WatchTraderHub answered the parts with the same cursor again", 200));
    const me = async (body: unknown) => client(scripted([json(200, body)]).fetch).c.me();
    for (const body of [null, [], 5, {}, { object: "list" }]) await expect(me(body), JSON.stringify(body)).rejects.toThrow(new WatchTraderHubApiError("WatchTraderHub answered the integration without one that reads", 200));
    expect(await me({ object: "integration", is_enabled: true })).toEqual({ object: "integration", is_enabled: true });
    await expect(client(scripted([json(503, error("internal_error"))]).fetch, { retries: 0 }).c.me()).rejects.toThrow("WatchTraderHub answered HTTP 503 for the integration (internal_error): m");
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([json(status, error("too_many_requests"), headers), empty]);
      const { c, slept } = client(fetch);
      await c.listings(first);
      expect(sent).toHaveLength(2);
      return slept;
    };
    expect(await waits({ "retry-after": "1" })).toEqual([1000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits({ "retry-after": value }), value).toEqual([1000]);
    // A Retry-After that isn't a whole number is no number of seconds at all: the second wait backs off to 2 seconds.
    for (const value of ["3.5", "3s"]) {
      const twice = scripted([json(429, {}), json(429, {}, { "retry-after": value }), empty]);
      const { c, slept } = client(twice.fetch);
      await c.listings(first);
      expect(slept, value).toEqual([1000, 2000]);
    }
    expect(await waits({})).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "3" }, status), String(status)).toEqual([3000]);
    const { fetch, sent } = scripted([json(503, error("query_failed"))]);
    const { c, slept } = client(fetch);
    await expect(c.listings(first)).rejects.toMatchObject({ status: 503, code: "query_failed" });
    expect([sent.length, slept]).toEqual([4, [1000, 2000, 4000]]);
    for (const status of [400, 404, 409, 501]) {
      const once = scripted([json(status, {})]);
      await expect(client(once.fetch).c.listings(first)).rejects.toMatchObject({ status });
      expect(once.sent, String(status)).toHaveLength(1);
    }
    const one = scripted([json(429, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.listings(first)).rejects.toMatchObject({ status: 429 });
    expect(one.sent).toHaveLength(2);
    for (const status of [401, 403]) {
      const unauthorized = scripted([json(status, {})]);
      await expect(client(unauthorized.fetch).c.listings(first)).rejects.toBeInstanceOf(WatchTraderHubConfigError);
      expect(unauthorized.sent).toHaveLength(1);
    }
  });

  it("works with the default sleep and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([json(429, {}, { "retry-after": "0" }), empty]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await watchTraderHubClient({ apiKey: KEY }).listings(first);
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("WatchTraderHub events", () => {
  it("reads ids, amounts, currencies, quantities, times and SKUs as WatchTraderHub writes them", () => {
    expect(watchTraderHubId(LISTING_1)).toBe(LISTING_1);
    expect(watchTraderHubId("i".repeat(64))).toBe("i".repeat(64));
    for (const id of ["i".repeat(65), "", "a b", "a/b", 5, null]) expect(watchTraderHubId(id), String(id)).toBeUndefined();
    for (const v of [0, 1, 1200000, 1e15]) expect(watchTraderHubCents(v)).toBe(v);
    for (const v of [-1, 1.5, "100", 1e15 + 1, Number.NaN, Number.POSITIVE_INFINITY, null]) expect(watchTraderHubCents(v), String(v)).toBeUndefined();
    expect(watchTraderHubCurrency("USD")).toBe("USD");
    for (const v of ["usd", "US", "USDT", 5, ["USD"]]) expect(watchTraderHubCurrency(v), String(v)).toBeUndefined();
    expect(watchTraderHubPrice({ amount: 1200000, currency: "USD", amount_formatted: "$12,000.00" })).toEqual({ cents: 1200000, currency: "USD" });
    expect(watchTraderHubPrice({ amount: 0, currency: "CHF" })).toEqual({ cents: 0, currency: "CHF" });
    for (const p of [null, [], 5, { amount: "12000.00", currency: "USD" }, { amount: 1, currency: "usd" }, { amount: -1, currency: "USD" }, { amount: 1 }, { currency: "USD" }]) expect(watchTraderHubPrice(p), JSON.stringify(p)).toBeUndefined();
    for (const v of [0, 1, 250]) expect(watchTraderHubQuantity(v)).toBe(v);
    for (const v of [-1, 1.5, "1", null]) expect(watchTraderHubQuantity(v), String(v)).toBeUndefined();
    expect(watchTraderHubTime("2026-05-08T08:41:16.770507+00:00")).toBe("2026-05-08T08:41:16.770Z");
    expect(watchTraderHubTime("2026-05-08T08:41Z")).toBe("2026-05-08T08:41:00.000Z");
    expect(watchTraderHubTime("2026-05-08T10:41:16+02:00")).toBe("2026-05-08T08:41:16.000Z");
    expect(watchTraderHubTime("2026-05-08T04:41:16-04:00")).toBe("2026-05-08T08:41:16.000Z");
    for (const t of ["2026-05-08", "2026-05-08T08:41:16", "x2026-05-08T08:41:16Z", "+002026-05-08T08:41:16Z", "2026-13-01T00:00:00Z", null, 5]) expect(watchTraderHubTime(t), String(t)).toBeUndefined();
    expect(watchTraderHubSku("  STOCK-1 ", "listing", "id-1")).toBe("STOCK-1");
    expect(watchTraderHubSku("s".repeat(150), "part", "id-1")).toBe("s".repeat(100));
    expect(watchTraderHubSku(" ", "listing", "id-1")).toBe("watchtraderhub-listing-id-1");
    expect(watchTraderHubSku(5, "part", "id-2")).toBe("watchtraderhub-part-id-2");
  });

  it("reads a listing as a watch with its stock, without descriptions, photos or labels", () => {
    const events = watchTraderHubListingEvents(listing(), RECEIVED).map((r) => r.event);
    const ref = `watchtraderhub:listing:${LISTING_1}`;
    expect(events[0]).toMatchObject({
      id: expect.stringMatching(new RegExp(`^watchtraderhub_listing_${LISTING_1}_[0-9a-f]{16}$`)),
      type: "product.updated",
      occurredAt: minutes(60),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^watchtraderhub:listing:${LISTING_1}:[0-9a-f]{16}$`)),
    });
    expect(events[0]!.payload).toEqual({
      productId: ref,
      title: "Test watch 1",
      status: "ACTIVE",
      vendor: "Testbrand",
      productType: "watch",
      tags: [],
      variants: [{ variantId: ref, sku: "SKU-TEST-0001", priceCents: 1000100, inventoryQuantity: 1 }],
    });
    expect(events[1]).toEqual({
      id: `watchtraderhub_listing_count_${LISTING_1}_1_2026-01-01T01_00_00.000Z`,
      type: "inventory.counted",
      occurredAt: minutes(60),
      receivedAt: RECEIVED,
      idempotencyKey: `watchtraderhub:listing_count:${LISTING_1}:1:2026-01-01T01:00:00.000Z`,
      payload: { sku: "SKU-TEST-0001", onHand: 1, variantId: ref, locationId: "watchtraderhub:location:loc-1" },
    });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/description|cdn\.|Very good|ext-listing|Testville|showroom/);
    const key = (raw: unknown) => watchTraderHubListingEvents(raw, RECEIVED)[0]!.event.idempotencyKey;
    expect(key(listing())).toBe(key(listing({ description: "changed", photos: [] })));
    expect(key(listing())).not.toBe(key(listing({ price: { amount: 1, currency: "USD" } })));
    expect(key(listing())).not.toBe(key(listing({ quantity: 2 })));
  });

  it("counts a sold watch as none on hand, and never invents a count", () => {
    const count = (over: WatchTraderHubMockRecord) => watchTraderHubListingEvents(listing(over), RECEIVED)[1]!;
    expect(count({ status: "sold" }).event.payload.onHand).toBe(0);
    expect(count({ status: "sold", quantity: null }).event.payload.onHand).toBe(0);
    expect(watchTraderHubListingEvents(listing({ status: "sold" }), RECEIVED)[0]!.event.payload).toMatchObject({ status: "ACTIVE", variants: [{ inventoryQuantity: 0 }] });
    expect(count({ quantity: 0 }).event.payload.onHand).toBe(0);
    expect(count({ quantity: 3 }).event).toMatchObject({ idempotencyKey: `watchtraderhub:listing_count:${LISTING_1}:3:2026-01-01T01:00:00.000Z`, payload: { onHand: 3 } });
    for (const quantity of [undefined, null, -1, 1.5, "1"]) {
      const [product, dead] = watchTraderHubListingEvents(listing({ quantity }), RECEIVED);
      expect(product!.ok, String(quantity)).toBe(true);
      expect((product!.event.payload.variants as { inventoryQuantity: unknown }[])[0]!.inventoryQuantity).toBeNull();
      expect(dead!.ok).toBe(false);
      expect(dead!.event).toMatchObject({ type: "inventory.counted", occurredAt: undefined, idempotencyKey: expect.stringMatching(/^watchtraderhub:unreadable_listing_count:[0-9a-f]{12}$/), payload: { system: "WatchTraderHub", kind: "listing_count", problems: ["listing has no quantity that reads"] } });
    }
  });

  it("falls back for a listing's title, brand, price, location and time", () => {
    const payload = (over: WatchTraderHubMockRecord) => watchTraderHubListingEvents(listing(over), RECEIVED)[0]!.event.payload;
    expect(payload({ title: " " }).title).toBe("Testbrand Model 1 REF-1");
    expect(payload({ title: null, watch: { model: "M", reference: " " } })).toMatchObject({ title: "M", vendor: null });
    expect(payload({ title: null, watch: null })).toMatchObject({ title: `WatchTraderHub listing ${LISTING_1}`, vendor: null });
    expect(payload({ title: "t".repeat(250) }).title).toBe("t".repeat(200));
    expect(payload({ watch: { brand: "b".repeat(150) } }).vendor).toBe("b".repeat(100));
    expect(payload({ watch: { brand: "Testbrand", stock_number: null } }).variants).toEqual([{ variantId: `watchtraderhub:listing:${LISTING_1}`, sku: `watchtraderhub-listing-${LISTING_1}`, priceCents: 1000100, inventoryQuantity: 1 }]);
    for (const price of [null, { amount: "10000.00", currency: "USD" }, { amount: 1, currency: "usd" }]) expect((payload({ price }).variants as { priceCents: unknown }[])[0]!.priceCents, JSON.stringify(price)).toBeNull();
    for (const store_location of [null, { id: "a b" }, { name: "x" }]) expect(watchTraderHubListingEvents(listing({ store_location }), RECEIVED)[1]!.event.payload).not.toHaveProperty("locationId");
    expect(watchTraderHubListingEvents(listing({ updated_at: null }), RECEIVED)[0]!.event.occurredAt).toBe(minutes(30));
    const undated = watchTraderHubListingEvents(listing({ updated_at: "soon", created_at: null }), RECEIVED).map((r) => r.event);
    expect(undated.map((e) => e.occurredAt)).toEqual([RECEIVED, RECEIVED]);
    expect(undated[1]!.idempotencyKey).toBe(`watchtraderhub:listing_count:${LISTING_1}:1:unknown`);
  });

  it("dead-letters a listing that doesn't read, with nothing else", () => {
    const problems = (raw: unknown) => {
      const r = watchTraderHubListingEvents(raw, RECEIVED);
      if (!r[0]!.ok) {
        expect(r).toHaveLength(1);
        expect(r[0]!.event).toMatchObject({ type: "product.updated", occurredAt: undefined, idempotencyKey: expect.stringMatching(/^watchtraderhub:unreadable_listing:[0-9a-f]{12}$/) });
      }
      return r[0]!.ok ? [] : (r[0]!.event.payload.problems as string[]);
    };
    expect(problems(null)).toEqual(["listing is not an object", "listing has no id that reads", "listing has no status that reads"]);
    expect(problems([])).toEqual(["listing is not an object", "listing has no id that reads", "listing has no status that reads"]);
    expect(problems(listing({ id: 5 }))).toEqual(["listing has no id that reads"]);
    for (const status of ["reserved", "sold_out", "ACTIVE", null, "constructor", ["active"]]) expect(problems(listing({ status })), String(status)).toEqual(["listing has no status that reads"]);
    expect(problems(listing({ status: "sold" }))).toEqual([]);
    const dead = watchTraderHubListingEvents(listing({ status: "x" }), RECEIVED)[0]!.event;
    expect(dead.payload).toEqual({ system: "WatchTraderHub", kind: "listing", problems: ["listing has no status that reads"] });
    expect(dead.id).toBe(dead.idempotencyKey.replace(/:/g, "_"));
    expect(watchTraderHubListingEvents(listing({ status: "x" }), RECEIVED)[0]!.event.idempotencyKey).toBe(dead.idempotencyKey);
    expect(watchTraderHubListingEvents(listing({ status: "y" }), RECEIVED)[0]!.event.idempotencyKey).not.toBe(dead.idempotencyKey);
  });

  it("reads a spare part with its maker and stock, and a sold-out part as none on hand", () => {
    const events = watchTraderHubPartEvents(part(), RECEIVED).map((r) => r.event);
    const ref = `watchtraderhub:part:${PART_1}`;
    expect(events[0]).toMatchObject({
      type: "product.updated",
      occurredAt: minutes(60),
      idempotencyKey: expect.stringMatching(new RegExp(`^watchtraderhub:part:${PART_1}:[0-9a-f]{16}$`)),
      payload: { productId: ref, title: "Test crown 1", status: "ACTIVE", vendor: "Testmaker", productType: "part", tags: [], variants: [{ variantId: ref, sku: "PART-TEST-0001", priceCents: 5100, inventoryQuantity: 1 }] },
    });
    expect(events[1]).toEqual({
      id: `watchtraderhub_part_count_${PART_1}_1_2026-01-01T01_00_00.000Z`,
      type: "inventory.counted",
      occurredAt: minutes(60),
      receivedAt: RECEIVED,
      idempotencyKey: `watchtraderhub:part_count:${PART_1}:1:2026-01-01T01:00:00.000Z`,
      payload: { sku: "PART-TEST-0001", onHand: 1, variantId: ref, locationId: "watchtraderhub:location:loc-1" },
    });
    expect(JSON.stringify(events)).not.toMatch(/description|Crown"|compatible|ext-part/);
    expect(watchTraderHubPartEvents(part({ status: "sold_out", quantity: 4 }), RECEIVED)[1]!.event.payload.onHand).toBe(0);
    expect(watchTraderHubPartEvents(part({ quantity: 7 }), RECEIVED)[1]!.event.payload.onHand).toBe(7);
    expect(watchTraderHubPartEvents(part({ part: { name: "n".repeat(250), manufacturer: "m".repeat(150) } }), RECEIVED)[0]!.event.payload).toMatchObject({ title: "n".repeat(200), vendor: "m".repeat(100) });
    expect(watchTraderHubPartEvents(part({ part: null }), RECEIVED)[0]!.event.payload).toMatchObject({ title: `WatchTraderHub part ${PART_1}`, vendor: null, variants: [{ sku: `watchtraderhub-part-${PART_1}` }] });
    const dead = watchTraderHubPartEvents(part({ quantity: null }), RECEIVED)[1]!;
    expect([dead.ok, dead.event.payload.problems]).toEqual([false, ["part has no quantity that reads"]]);
    for (const status of ["sold", "x"]) expect(watchTraderHubPartEvents(part({ status }), RECEIVED).map((r) => [r.ok, r.event.payload.problems])).toEqual([[false, ["part has no status that reads"]]]);
    expect(watchTraderHubPartEvents(null, RECEIVED)[0]!.event.payload.problems).toEqual(["part is not an object", "part has no id that reads", "part has no status that reads"]);
  });

  it("reads an order as its state and totals, without the buyer", () => {
    const events = watchTraderHubOrderEvents(order(), RECEIVED).map((r) => r.event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "order.updated",
      occurredAt: minutes(55),
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(new RegExp(`^watchtraderhub:order:${ORDER_1}:matched:[0-9a-f]{16}$`)),
    });
    expect(events[0]!.payload).toEqual({
      system: "WatchTraderHub",
      orderId: `watchtraderhub:order:${ORDER_1}`,
      channelOrderId: "SITE-1001",
      createdAt: minutes(55),
      status: "MATCHED",
      shipped: true,
      cancelled: false,
      channel: "online",
      currency: "USD",
      shippingCents: 2500,
      taxCents: 0,
      discountCents: 0,
      totalCents: 1000100,
      lineCount: 1,
    });
    expect(JSON.stringify(events)).not.toMatch(/buyer|Test Customer|example\.test|212 555|Test Street|00000"|REF-1|shop-1/);
    const key = (raw: unknown) => watchTraderHubOrderEvents(raw, RECEIVED)[0]!.event.idempotencyKey;
    expect(key(order())).toBe(key(order({ buyer: null, created_at: minutes(999) })));
    expect(key(order())).not.toBe(key(order({ total_amount: 1 })));
    expect(key(order())).not.toBe(key(order({ line_items: [] })));
  });

  it("maps each order status, and leaves out an amount or number that doesn't read", () => {
    const at = (over: WatchTraderHubMockRecord) => watchTraderHubOrderEvents(order(over), RECEIVED)[0]!.event;
    const table = ["pending", "matched", "dismissed"].map((status) => {
      const p = at({ status }).payload;
      return [status, p.status, p.shipped, p.cancelled];
    });
    expect(table).toEqual([
      ["pending", "PENDING", false, false],
      ["matched", "MATCHED", true, false],
      ["dismissed", "DISMISSED", false, true],
    ]);
    expect(new Set(["pending", "matched", "dismissed"].map((status) => at({ status }).idempotencyKey)).size).toBe(3);
    const payload = at({ shipping_amount: -1, tax_amount: "1", discount_amount: 1.5, channel_order_id: " " }).payload;
    for (const field of ["shippingCents", "taxCents", "discountCents", "channelOrderId"]) expect(payload, field).not.toHaveProperty(field);
    expect(at({ shipping_amount: undefined, tax_amount: 7 }).payload).toMatchObject({ taxCents: 7 });
    expect(at({ channel_order_id: "c".repeat(150) }).payload.channelOrderId).toBe("c".repeat(100));
    expect(at({ ordered_at: null })).toMatchObject({ occurredAt: minutes(60), payload: { createdAt: minutes(60) } });
    expect(at({ line_items: [] }).payload.lineCount).toBe(0);
    expect(at({ total_amount: 0 }).payload.totalCents).toBe(0);
  });

  it("dead-letters an order that doesn't read", () => {
    const problems = (raw: unknown) => {
      const r = watchTraderHubOrderEvents(raw, RECEIVED);
      expect(r).toHaveLength(1);
      expect(r[0]!.event.occurredAt === undefined).toBe(!r[0]!.ok);
      return r[0]!.ok ? [] : (r[0]!.event.payload.problems as string[]);
    };
    expect(problems(null)).toEqual(["order is not an object", "order has no id that reads", "order has no status that reads", "order has no currency that reads", "order has no total that reads", "order has no time that reads", "order has no line items that read"]);
    expect(problems([])).toContain("order is not an object");
    expect(problems(order({ id: "" }))).toEqual(["order has no id that reads"]);
    for (const status of ["fulfilled", "cancelled", "MATCHED", null, "constructor", ["matched"]]) expect(problems(order({ status })), String(status)).toEqual(["order has no status that reads"]);
    expect(problems(order({ currency: "usd" }))).toEqual(["order has no currency that reads"]);
    for (const total_amount of [null, -1, 1.5, "1000"]) expect(problems(order({ total_amount })), String(total_amount)).toEqual(["order has no total that reads"]);
    expect(problems(order({ ordered_at: "soon", created_at: null }))).toEqual(["order has no time that reads"]);
    for (const line_items of [null, {}, "x"]) expect(problems(order({ line_items })), JSON.stringify(line_items)).toEqual(["order has no line items that read"]);
    const dead = watchTraderHubOrderEvents(order({ status: 5 }), RECEIVED)[0]!.event;
    expect(dead).toMatchObject({ type: "order.updated", idempotencyKey: expect.stringMatching(/^watchtraderhub:unreadable_order:[0-9a-f]{12}$/), payload: { system: "WatchTraderHub", kind: "order", problems: ["order has no status that reads"] } });
  });
});

describe("WatchTraderHub connector", () => {
  it("passes the shared sync checks", async () => {
    // Three listings and two parts, each a product and a count (10), and two orders (2).
    const result = await checkConnectorSync({ makeConnector: () => connector(watchTraderHubDocMock(account())), payloadSchemas: SCHEMAS, expected: { ingested: 12 } });
    expect(result.full.batches).toBe(3);
    expect(parseWatchTraderHubCursor(result.full.cursor)).toEqual({ done: true, step: null, page: null, since: RECEIVED, started: null });
  });

  it("checks the integration, then imports every listing, part and order, 250 a page, and stops for good", async () => {
    reset();
    const mock = watchTraderHubDocMock({ key: KEY, listings: watchTraderHubListing.many(WATCHTRADERHUB_PAGE_SIZE + 1), parts: watchTraderHubPart.many(1), orders: watchTraderHubOrder.many(1) });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 2 * (WATCHTRADERHUB_PAGE_SIZE + 1) + 2 + 1, deadLettered: 0, batches: 4 });
    expect(mock.fetch.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/me", "/api/v1/listings", "/api/v1/listings", "/api/v1/parts", "/api/v1/orders"]);
    expect(reads(mock)).toEqual(["/listings first all", "/listings next all", "/parts first all", "/orders first all"]);
    expect(mock.reads.every((r) => r.limit === 250)).toBe(true);
    // Newest change first, as the docs say.
    const products = memory.events.filter((e) => e.type === "product.updated").map((e) => e.payload.title);
    expect(products.slice(0, 2)).toEqual([`Test watch ${WATCHTRADERHUB_PAGE_SIZE + 1}`, `Test watch ${WATCHTRADERHUB_PAGE_SIZE}`]);
    // Each list goes to its own reader: the part reads as a part and the order as an order.
    const types = memory.events.filter((e) => e.type === "product.updated").map((e) => e.payload.productType);
    expect([types.filter((t) => t === "watch").length, types.filter((t) => t === "part").length]).toEqual([WATCHTRADERHUB_PAGE_SIZE + 1, 1]);
    expect(memory.events.find((e) => e.payload.productType === "part")!.payload).toMatchObject({ title: "Test crown 1", vendor: "Testmaker" });
    expect(memory.events.filter((e) => e.type === "order.updated")).toHaveLength(1);
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.stringify(memory.events.map((e) => e.payload))).not.toMatch(/buyer|Test Customer|example\.test|description/);
    expect(parseWatchTraderHubCursor(report.cursor)).toEqual({ done: true, step: null, page: null, since: RECEIVED, started: null });
    const calls = mock.fetch.calls.length;
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, mock.fetch.calls.length]).toEqual([0, calls]);
  });

  it("checkpoints each page with its cursor, and resumes the import from it", async () => {
    reset();
    const data: WatchTraderHubMockData = { key: KEY, listings: watchTraderHubListing.many(WATCHTRADERHUB_PAGE_SIZE + 1), parts: [], orders: watchTraderHubOrder.many(2) };
    const all = await drain(connector(watchTraderHubDocMock(data)).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cursors = all.map((b) => parseWatchTraderHubCursor(b.cursor)!);
    expect(cursors.map((c) => [c.done, c.step, c.page === null, c.since, c.started])).toEqual([
      [false, "listings", false, null, RECEIVED],
      [false, "parts", true, null, RECEIVED],
      [false, "orders", true, null, RECEIVED],
      [true, null, true, RECEIVED, null],
    ]);
    const mock = watchTraderHubDocMock(data);
    const resumed = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: all[0]!.cursor }));
    expect(reads(mock)).toEqual(["/listings next all", "/parts first all", "/orders first all"]);
    expect(mock.reads[0]!.after).toBe(cursors[0]!.page);
    expect(eventsOf(resumed).filter((e) => e.type === "product.updated").map((e) => e.payload.title)).toEqual(["Test watch 1"]);
    const atOrders = watchTraderHubDocMock(data);
    await drain(connector(atOrders).historicalImport({ organizationId: TEST_ORG, cursor: all[2]!.cursor }));
    expect(reads(atOrders)).toEqual(["/orders first all"]);
    // A resumed pass keeps the time it began, whatever the clock says now.
    const later = await drain(connector(watchTraderHubDocMock(data), { now: () => new Date("2026-12-01T00:00:00.000Z") }).historicalImport({ organizationId: TEST_ORG, cursor: all[2]!.cursor }));
    expect(parseWatchTraderHubCursor(later.at(-1)!.cursor)!.since).toBe(RECEIVED);
    const done = watchTraderHubDocMock(data);
    expect(await drain(connector(done).historicalImport({ organizationId: TEST_ORG, cursor: all[3]!.cursor }))).toEqual([]);
    expect(done.fetch.calls).toEqual([]);
  });

  it("reads only the last 30 days on a first later sync, then what changed since the last pass began, less an hour", async () => {
    expect([WATCHTRADERHUB_FIRST_WINDOW_DAYS, WATCHTRADERHUB_OVERLAP_MINUTES]).toEqual([30, 60]);
    // Changed 31, 30 and 29 days ago, and half an hour ago.
    const data = (): WatchTraderHubMockData => {
      reset();
      return { key: KEY, listings: [daysAgo(31), daysAgo(30), daysAgo(29), daysAgo(1 / 48)].map((updated_at) => watchTraderHubListing.one({ updated_at })), parts: [], orders: [] };
    };
    const mock = watchTraderHubDocMock(data());
    const firstSync = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(reads(mock)).toEqual([`/listings first ${daysAgo(30)}`, `/parts first ${daysAgo(30)}`, `/orders first ${daysAgo(30)}`]);
    expect(eventsOf(firstSync).filter((e) => e.type === "product.updated").map((e) => e.payload.title)).toEqual(["Test watch 4", "Test watch 3"]);
    const end = parseWatchTraderHubCursor(firstSync.at(-1)!.cursor)!;
    expect(end).toEqual({ done: true, step: null, page: null, since: RECEIVED, started: null });
    // The next pass, a day later, reads from an hour before this one began.
    const next = watchTraderHubDocMock(data());
    const tomorrow = () => new Date(Date.parse(RECEIVED) + 86_400_000);
    const batches = await drain(connector(next, { now: tomorrow }).incrementalSync({ organizationId: TEST_ORG, cursor: firstSync.at(-1)!.cursor }));
    expect(next.reads.map((r) => r.updatedAfter)).toEqual(Array(3).fill("2026-11-11T14:00:00.000Z"));
    expect(eventsOf(batches).filter((e) => e.type === "product.updated").map((e) => e.payload.title)).toEqual(["Test watch 4"]);
    expect(parseWatchTraderHubCursor(batches.at(-1)!.cursor)).toEqual({ done: true, step: null, page: null, since: tomorrow().toISOString(), started: null });
    const edge = watchTraderHubDocMock(data());
    await drain(connector(edge).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: true, step: null, page: null, since: "2026-11-11T14:00:00.000Z", started: null }) }));
    expect(edge.reads[0]!.updatedAfter).toBe("2026-11-11T13:00:00.000Z");
  });

  it("resumes a later sync at its saved page and window", async () => {
    const data = account();
    const mock = watchTraderHubDocMock(data);
    const since = "2025-12-31T00:00:00.000Z";
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ step: "parts", since, started: "2026-11-10T00:00:00.000Z" }) }));
    expect(reads(mock)).toEqual([`/parts first ${since}`, `/orders first ${since}`]);
    expect(parseWatchTraderHubCursor(batches.at(-1)!.cursor)).toEqual({ done: true, step: null, page: null, since: "2026-11-10T00:00:00.000Z", started: null });
    // A cursor WatchTraderHub gave is sent back as it was, and /me is read first.
    const asked: string[] = [];
    const fake: WatchTraderHubClient = {
      me: async () => (asked.push("me"), { object: "integration", is_enabled: true }),
      listings: async () => (asked.push("listings"), { data: [], nextCursor: null }),
      parts: async () => (asked.push("parts"), { data: [], nextCursor: null }),
      orders: async (request) => (asked.push("orders"), expect(request).toEqual({ after: "opaque-1", updatedAfter: since }), { data: [], nextCursor: null }),
    };
    const out = await drain(watchTraderHubConnector({ apiKey: KEY, client: fake, now: NOW }).incrementalSync({ organizationId: TEST_ORG, cursor: cursorOf({ step: "orders", page: "opaque-1", since }) }));
    expect([out.length, asked]).toEqual([1, ["me", "orders"]]);
  });

  it("keeps what doesn't read as dead letters", async () => {
    const data = account();
    data.listings![0] = { ...data.listings![0]!, status: "reserved" };
    data.listings![1] = { ...data.listings![1]!, quantity: null };
    data.parts![0] = { ...data.parts![0]!, id: "a b" };
    data.orders![0] = { ...data.orders![0]!, total_amount: "lots" };
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(watchTraderHubDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Read: listing 2's product, listing 3 (2), part 2 (2) and order 2. Dead: listing 1, listing 2's count, part 1 and order 1.
    expect(report).toMatchObject({ ingested: 6, deadLettered: 4 });
  });

  it("stops on a key WatchTraderHub turns down, a paused integration or a lapsed plan, before reading any list", async () => {
    const wrong = watchTraderHubDocMock({ ...account(), key: OTHER_KEY });
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(wrong), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep })).rejects.toThrow(WatchTraderHubConfigError);
    expect(await memory.getCheckpoint(TEST_ORG, "watchtraderhub", "historical")).toBeNull();
    expect(wrong.reads).toEqual([]);
    expect(wrong.fetch.calls.every((c) => c.url === `${WATCHTRADERHUB_API_BASE}/me`)).toBe(true);
    const failure = async (mock: WatchTraderHubMock) => drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null })).then(() => null, (e: unknown) => e as Error);
    const paused = watchTraderHubDocMock(account({ disabled: true }));
    const stopped = await failure(paused);
    expect(stopped).toEqual(new WatchTraderHubConfigError("the WatchTraderHub integration for WATCHTRADERHUB_API_KEY is disabled; the dealer enables it under Custom Integration, Settings"));
    expect(paused.reads).toEqual([]);
    const lapsed = await failure(watchTraderHubDocMock(account({ unsubscribed: true })));
    expect(lapsed!.message).toBe("WatchTraderHub turned down the API key (HTTP 403) (subscription_required): The dealer's plan does not include the custom integration.; WATCHTRADERHUB_API_KEY must be the current key of an enabled custom integration on the dealer's Business plan");
    for (const e of [stopped, lapsed]) expect(e!.message).not.toContain(KEY);
    // Only is_enabled false stops it: a /me without the flag carries on.
    const fake: WatchTraderHubClient = { me: async () => ({ object: "integration" }), listings: async () => ({ data: [], nextCursor: null }), parts: async () => ({ data: [], nextCursor: null }), orders: async () => ({ data: [], nextCursor: null }) };
    expect(await drain(watchTraderHubConnector({ apiKey: KEY, client: fake, now: NOW }).historicalImport({ organizationId: TEST_ORG, cursor: null }))).toHaveLength(3);
  });

  it("waits out WatchTraderHub's rate limit and carries on", async () => {
    const slept: number[] = [];
    const mock = watchTraderHubDocMock(account({ rateLimits: 2 }));
    const events = eventsOf(await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ organizationId: TEST_ORG, cursor: null })));
    expect([events.length, slept]).toEqual([12, [1000, 1000]]);
  });

  it("uses the real clock by default, and declares its write, turned down", async () => {
    const before = Date.now();
    const out = await drain(watchTraderHubConnector({ apiKey: KEY, fetch: watchTraderHubDocMock(account()).fetch, sleep: noSleep }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(Date.parse(eventsOf(out)[0]!.receivedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(parseWatchTraderHubCursor(out.at(-1)!.cursor)!.since!)).toBeGreaterThanOrEqual(before);
    const c = connector(watchTraderHubDocMock(account()));
    expect(c.source).toBe("watchtraderhub");
    expect(c.writes).toBe(WATCHTRADERHUB_WRITES);
    expect(WATCHTRADERHUB_WRITES).toEqual([{ integration: "watchtraderhub", name: "cancel_order", description: "Cancel an order reported to WatchTraderHub", kind: "update", approval: "each", dailyCap: 5 }]);
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    for (const action of c.writes ?? []) {
      await expect(gate.run(action, "watchtraderhub-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(false);
    expect(audit.entries).toMatchObject([{ action: "cancel_order", integration: "watchtraderhub" }]);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });

  it("turns down a checkpoint that isn't its own", () => {
    const good: WatchTraderHubCursor[] = [
      { done: false, step: "listings", page: null, since: null, started: RECEIVED },
      { done: false, step: "parts", page: "abc", since: "2026-01-01T00:00:00.000Z", started: RECEIVED },
      { done: false, step: "orders", page: "c".repeat(2048), since: null, started: RECEIVED },
      { done: true, step: null, page: null, since: RECEIVED, started: null },
    ];
    expect(parseWatchTraderHubCursor(null)).toBeNull();
    for (const c of good) expect(parseWatchTraderHubCursor(JSON.stringify(c))).toEqual(c);
    // The keys may come in any order.
    expect(parseWatchTraderHubCursor(JSON.stringify({ started: null, since: RECEIVED, page: null, step: null, done: true }))).toEqual(good[3]);
    const open = { done: false, step: "listings", page: null, since: null, started: RECEIVED };
    const done = { done: true, step: null, page: null, since: RECEIVED, started: null };
    const bad: unknown[] = [
      "",
      "{",
      "null",
      "[]",
      "5",
      {},
      { ...open, extra: 1 },
      { done: false, step: "listings", page: null, since: null },
      { ...open, done: "false" },
      { ...open, step: "customers" },
      { ...open, step: null },
      { ...open, page: "" },
      { ...open, page: "c".repeat(2049) },
      { ...open, page: 5 },
      { ...open, since: "2026-01-01T00:00:00Z" },
      { ...open, since: 5 },
      { ...open, started: null },
      { ...open, started: "soon" },
      { ...done, step: "orders" },
      { ...done, page: "abc" },
      { ...done, since: null },
      { ...done, started: RECEIVED },
      { ...done, done: false },
      { ...done, done: "true" },
      { ...done, since: "2026-13-01T00:00:00.000Z" },
      { ...open, started: "2026-13-01T00:00:00.000Z" },
      // Another connector's checkpoints.
      { done: true, step: null, page: null },
      { done: false, step: "orders", page: null },
      { pass: "historical", step: 0, offset: 0, since: 0, nextSince: 0 },
    ];
    for (const raw of bad) expect(() => parseWatchTraderHubCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("WatchTraderHub checkpoint is not in the expected shape");
  });
});

describe("WatchTraderHub doc mock", () => {
  const get = (mock: WatchTraderHubMock, path = "/listings", query = "", headers: Record<string, string> = { authorization: BEARER }) => mock.fetch(`${WATCHTRADERHUB_API_BASE}${path}${query}`, { headers });
  const body = async (response: Response) => (await response.json()) as { object?: string; data: { id: string; title?: string }[]; has_more: boolean; next_cursor: string | null; is_enabled?: boolean; error?: { code: string; type: string; param?: string } };

  it("uses only synthetic data, and says where it came from", () => {
    const data = account();
    assertSynthetic([data.listings, data.parts, data.orders]);
    const { mock } = watchTraderHubDocMock(data);
    expect(mock.source).toEqual({ url: WATCHTRADERHUB_DOC_PAGES.quickstart, title: "WatchTraderHub API: Quickstart", retrievedOn: "2026-11-11", version: "2026-05-07" });
    expect(mock.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([
      `GET /me ${WATCHTRADERHUB_DOC_PAGES.quickstart}`,
      `GET /listings ${WATCHTRADERHUB_DOC_PAGES.pagination}`,
      `GET /parts ${WATCHTRADERHUB_DOC_PAGES.pagination}`,
      `GET /orders ${WATCHTRADERHUB_DOC_PAGES.pagination}`,
    ]);
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "watchtraderhub")!;
    expect(module.watchPages).toEqual(Object.values(WATCHTRADERHUB_DOC_PAGES));
    expect(module.docMocks().map((m) => m.integration)).toEqual(["watchtraderhub"]);
    expect(Object.values(WATCHTRADERHUB_DOC_PAGES).every((u) => u.startsWith("https://www.watchtraderhub.com/docs/api/"))).toBe(true);
  });

  it("checks the key as the authentication page says", async () => {
    const mock = watchTraderHubDocMock(account());
    const code = async (headers: Record<string, string>, path = "/listings") => {
      const r = await get(mock, path, "", headers);
      return [r.status, (await body(r)).error?.code];
    };
    expect(await code({ authorization: `Bearer ${OTHER_KEY}` })).toEqual([401, "invalid_api_key"]);
    expect(await code({ authorization: `Bearer ${OTHER_KEY}` }, "/me")).toEqual([401, "invalid_api_key"]);
    expect(await code({ authorization: "Bearer wth_short" })).toEqual([401, "malformed_authorization"]);
    expect(await code({ authorization: `Bearer ${KEY}x` })).toEqual([401, "malformed_authorization"]);
    expect((await get(mock, "/listings", "", {})).status).toBe(401);
    expect(await code({ authorization: BEARER })).toEqual([200, undefined]);
  });

  it("answers the integration, and a paused or lapsed one as the errors page says", async () => {
    const me = await body(await get(watchTraderHubDocMock(account()), "/me"));
    expect(me).toMatchObject({ object: "integration", is_enabled: true, api_version: "2026-05-07" });
    const paused = watchTraderHubDocMock(account({ disabled: true }));
    expect((await body(await get(paused, "/me"))).is_enabled).toBe(false);
    const list = await get(paused, "/orders");
    expect([list.status, (await body(list)).error]).toMatchObject([403, { code: "integration_disabled", type: "permission_error" }]);
    const lapsed = watchTraderHubDocMock(account({ unsubscribed: true }));
    for (const path of ["/me", "/parts"]) expect((await body(await get(lapsed, path))).error?.code, path).toBe("subscription_required");
  });

  it("lists, pages and filters as the pagination page says, newest change first", async () => {
    reset();
    const sixty = watchTraderHubListing.many(60);
    const ties = [watchTraderHubListing.one({ id: "b", updated_at: minutes(5) }), watchTraderHubListing.one({ id: "c", updated_at: minutes(5) })];
    const mock = watchTraderHubDocMock({ key: KEY, listings: [...sixty, ...ties] });
    const firstPage = await body(await get(mock));
    expect([firstPage.object, firstPage.data.length, firstPage.has_more]).toEqual(["list", 50, true]);
    expect(firstPage.data[0]!.title).toBe("Test watch 60");
    const next = await body(await get(mock, "/listings", `?after=${firstPage.next_cursor}`));
    // Ties on updated_at go by id, descending: c (watch 62) before b (watch 61).
    const older = Array.from({ length: 10 }, (_, i) => `Test watch ${10 - i}`);
    expect([next.data.map((l) => l.title), next.has_more, next.next_cursor]).toEqual([[...older, "Test watch 62", "Test watch 61"], false, null]);
    expect((await body(await get(mock, "/listings", "?limit=250"))).data).toHaveLength(62);
    const tied = watchTraderHubDocMock({ key: KEY, listings: ties });
    const one = await body(await get(tied, "/listings", "?limit=1"));
    expect([one.data.map((l) => l.id), one.has_more]).toEqual([["c"], true]);
    expect((await body(await get(tied, "/listings", `?limit=1&after=${one.next_cursor}`))).data.map((l) => l.id)).toEqual(["b"]);
    // A page that holds exactly the rows left is the last.
    const whole = await body(await get(tied, "/listings", "?limit=2"));
    expect([whole.data.length, whole.has_more, whole.next_cursor]).toEqual([2, false, null]);
    expect((await body(await get(mock, "/listings", `?updated_after=${minutes(59 * 60)}`))).data.map((l) => l.title)).toEqual(["Test watch 60"]);
    expect((await body(await get(mock, "/listings", `?updated_after=${minutes(60 * 60)}`))).data).toEqual([]);
    expect((await body(await get(mock, "/parts"))).data).toEqual([]);
    expect(mock.reads.at(-1)).toEqual({ path: "/parts", limit: 50, after: null, updatedAfter: null });
    reset();
    const orders = watchTraderHubDocMock({ key: KEY, orders: watchTraderHubOrder.many(2) });
    expect((await body(await get(orders, "/orders", `?updated_after=${minutes(60)}`))).data.map((o) => o.id)).toEqual(["d7df4fbe-0000-4000-a000-a00000000002"]);
  });

  it("answers 400 and 429 as the errors page says", async () => {
    const mock = watchTraderHubDocMock(account({ rateLimits: 1 }));
    const limited = await get(mock);
    expect([limited.status, limited.headers.get("retry-after"), (await body(limited)).error]).toMatchObject([429, "1", { code: "too_many_requests", type: "rate_limit_error" }]);
    for (const q of ["?limit=0", "?limit=251", "?limit=1.5", "?cursor=x", "?updated_since=2026-01-01T00:00:00Z", "?updated_after=2026-01-01", "?updated_after=2026-13-01T00:00:00Z"]) {
      const r = await get(mock, "/listings", q);
      const e = (await body(r)).error;
      expect([r.status, e?.code, e?.type], q).toEqual([400, "invalid_request", "validation_error"]);
    }
    expect((await get(mock, "/listings", "?limit=250")).status).toBe(200);
    const page = await body(await get(mock, "/listings", "?limit=1"));
    for (const after of ["junk", Buffer.from("[]").toString("base64url"), Buffer.from('{"path":"/listings","id":5}').toString("base64url")]) {
      expect((await body(await get(mock, "/listings", `?after=${after}`))).error?.code, after).toBe("invalid_cursor");
    }
    expect((await body(await get(mock, "/parts", `?after=${page.next_cursor}`))).error?.code).toBe("invalid_cursor");
    expect((await get(mock, "/listings", `?after=${page.next_cursor}`)).status).toBe(200);
  });

  it("throws on a look-alike host and anything the client must never send", async () => {
    const mock = watchTraderHubDocMock(account());
    await expect(mock.fetch("https://www.watchtraderhub.com.example.test/api/v1/listings", {})).rejects.toThrow(UndocumentedRequestError);
    for (const path of ["/orders", `/orders/${ORDER_1}/cancel`, "/customers", "/customers/bulk", "/test/webhook_ping"]) {
      await expect(mock.fetch(`${WATCHTRADERHUB_API_BASE}${path}`, { method: "POST", body: "{}", headers: { authorization: BEARER } }), path).rejects.toThrow(UndocumentedRequestError);
    }
    await expect(mock.fetch(`${WATCHTRADERHUB_API_BASE}/listings/${LISTING_1}`, { headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
