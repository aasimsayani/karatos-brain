import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { ETSY_TEST_SHOP, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, etsyDocMock, etsyListing, etsyReceipt, testPipeline, type EtsyMock, type EtsyMockData } from "@karatos/connector-testkit";
import {
  ETSY_API_URL,
  ETSY_EPOCH_MIN,
  ETSY_LISTING_STATES,
  ETSY_OVERLAP_S,
  ETSY_PAGE_SIZE,
  ETSY_TOKEN_URL,
  ETSY_WRITES,
  EtsyApiError,
  EtsyConfigError,
  etsyCents,
  etsyClient,
  etsyConnector,
  etsyExtraScopes,
  etsyId,
  etsyListingEvents,
  etsyPaymentMethod,
  etsyReceiptEvents,
  etsySku,
  etsyTime,
  memoryTokenStore,
  parseEtsyCursor,
  type EtsyClient,
  type EtsyClientOptions,
  type EtsyConnectorOptions,
  type EtsyCursor,
  type EtsyReceiptQuery,
} from "../src/index.js";

// Key-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEYSTRING = ["test", "keystring", "0".repeat(8)].join("");
const SECRET = ["test", "secret", "1".repeat(6)].join("");
const REFRESH = ["70000001", "testrefresh" + "0".repeat(13)].join(".");
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const NOW_S = Date.parse("2026-11-10T15:00:00.000Z") / 1000;
const RECEIVED = "2026-11-10T15:00:00.000Z";
const CTX = { receivedAt: RECEIVED, shopId: ETSY_TEST_SHOP };
const SHOP = `${ETSY_API_URL}/shops/${ETSY_TEST_SHOP}`;
const noSleep = async () => {};
const BASE = 1_767_225_600;
const money = (amount: number, divisor = 100) => ({ amount, divisor, currency_code: "USD" });

function shop(overrides: Partial<EtsyMockData> = {}): EtsyMockData {
  etsyReceipt.reset();
  etsyListing.reset();
  return { keystring: KEYSTRING, sharedSecret: SECRET, refreshToken: REFRESH, receipts: etsyReceipt.many(3), listings: etsyListing.many(2), ...overrides };
}

// One token store per mock, as an instance keeps one: the mock replaces the refresh token on every refresh.
const stores = new WeakMap<EtsyMock, ReturnType<typeof memoryTokenStore>>();
const storeFor = (mock: EtsyMock) => stores.get(mock) ?? (stores.set(mock, memoryTokenStore(REFRESH)), stores.get(mock)!);
const options = (mock: EtsyMock, extra: Partial<EtsyClientOptions> = {}): EtsyClientOptions => ({ keystring: KEYSTRING, sharedSecret: SECRET, shopId: ETSY_TEST_SHOP, tokens: storeFor(mock), fetch: mock.fetch, sleep: noSleep, ...extra });
const connector = (mock: EtsyMock, extra: Partial<EtsyConnectorOptions> = {}) => etsyConnector({ ...options(mock), now: NOW, ...extra });

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const paths = (mock: EtsyMock) => mock.fetch.calls.map((c) => `${c.method} ${c.url.replace("https://api.etsy.com", "")}`);

describe("Etsy client", () => {
  it("checks its settings before sending anything", () => {
    const mock = etsyDocMock(shop());
    const bad: Partial<EtsyClientOptions>[] = [
      { keystring: "" }, { keystring: "a".repeat(7) }, { keystring: "a-b".repeat(4) }, { keystring: "a".repeat(65) }, { keystring: undefined as never },
      { sharedSecret: "" }, { sharedSecret: "b".repeat(5) }, { sharedSecret: "abc def" }, { sharedSecret: "a".repeat(129) }, { sharedSecret: undefined as never },
    ];
    for (const b of bad) expect(() => etsyClient(options(mock, b)), JSON.stringify(b)).toThrow(new EtsyConfigError("set ETSY_KEYSTRING and ETSY_SHARED_SECRET to the app's keystring and shared secret"));
    for (const shopId of ["", "0", "01", "shop", "1".repeat(19), undefined as never]) expect(() => etsyClient(options(mock, { shopId })), String(shopId)).toThrow(new EtsyConfigError("ETSY_SHOP_ID must be the shop's numeric id"));
    expect(() => etsyClient(options(mock, { keystring: ` ${"a".repeat(8)} `, sharedSecret: ` ${"b".repeat(6)} `, shopId: ` ${"9".repeat(18)} ` }))).not.toThrow();
    expect(() => etsyClient(options(mock, { keystring: "a".repeat(64), sharedSecret: "b".repeat(128) }))).not.toThrow();
    expect(mock.fetch.calls).toEqual([]);
  });

  it("refreshes, saves the new refresh token, checks the scopes and the shop, then reads with the key and token", async () => {
    const mock = etsyDocMock(shop());
    const tokens = memoryTokenStore(` ${REFRESH} `);
    const client = etsyClient(options(mock, { tokens }));
    expect(await client.receipts({ by: "created", since: 1_636_556_400, offset: 0 })).toHaveLength(3);
    expect(await client.listings("active", 100)).toEqual([]);
    expect(tokens.current).toBe(mock.refreshToken);
    expect(tokens.current).not.toBe(REFRESH);
    expect(paths(mock)).toEqual([
      "POST /v3/public/oauth/token",
      "POST /v3/application/scopes",
      "GET /v3/application/users/me",
      `GET /v3/application/shops/${ETSY_TEST_SHOP}/receipts?min_created=1636556400&sort_on=created&sort_order=asc&limit=100&offset=0`,
      `GET /v3/application/shops/${ETSY_TEST_SHOP}/listings?state=active&includes=Inventory&limit=100&offset=100`,
    ]);
    expect(await client.receipts({ by: "updated", since: ETSY_EPOCH_MIN, offset: 7 })).toEqual([]);
    expect(mock.reads.at(-1)!.query).toEqual({ min_last_modified: String(ETSY_EPOCH_MIN), sort_on: "updated", sort_order: "asc", limit: "100", offset: "7" });
    expect(mock.accessTokens).toHaveLength(1);
  });

  it("sends exactly the requests it means to", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answers: Record<string, unknown> = {
      [ETSY_TOKEN_URL]: { access_token: "70000001.accesstoken000000", expires_in: 3600, refresh_token: "  " },
      [`${ETSY_API_URL}/scopes`]: { scopes: ["listings_r", "transactions_r", "profile_r"] },
      [`${ETSY_API_URL}/users/me`]: { user_id: 70000001, shop_id: 50000001 },
    };
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(answers[url.split("?")[0]!] ?? { count: 0, results: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const tokens = memoryTokenStore(REFRESH);
    await etsyClient({ keystring: KEYSTRING, sharedSecret: SECRET, shopId: ETSY_TEST_SHOP, tokens, fetch }).listings("draft", 0);
    expect(tokens.current).toBe(REFRESH);
    const key = `${KEYSTRING}:${SECRET}`;
    expect(sent.map((s) => [s.url, s.init.method, s.init.headers, s.init.body])).toEqual([
      [ETSY_TOKEN_URL, "POST", { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, `grant_type=refresh_token&client_id=${KEYSTRING}&refresh_token=${REFRESH.replace(".", ".")}`],
      [`${ETSY_API_URL}/scopes`, "POST", { "x-api-key": key, "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, "token=70000001.accesstoken000000"],
      [`${ETSY_API_URL}/users/me`, "GET", { "x-api-key": key, authorization: "Bearer 70000001.accesstoken000000", accept: "application/json" }, undefined],
      [`${SHOP}/listings?state=draft&includes=Inventory&limit=100&offset=0`, "GET", { "x-api-key": key, authorization: "Bearer 70000001.accesstoken000000", accept: "application/json" }, undefined],
    ]);
  });

  it("stops when the connection could change anything, lacks a read scope, or its scopes can't be read", async () => {
    const cases: [NonNullable<EtsyMockData["scopes"]>, string][] = [
      [["transactions_r", "listings_r", "listings_w"], "the Etsy connection can change data (listings_w); reconnect it with only transactions_r listings_r"],
      [["transactions_r", "listings_r", "listings_d", "shops_w", "email_r", "a_w", "b_w", "c_w"], "the Etsy connection can change data (listings_d, shops_w, a_w, b_w, c_w); reconnect it with only transactions_r listings_r"],
      [["transactions_r", "listings_r", "Listings_R"], "the Etsy connection can change data (Listings_R)"],
      [["transactions_r", "listings_r", " listings_r"], "the Etsy connection can change data ( listings_r)"],
      [["transactions_r", "listings_r", "listings_rw"], "the Etsy connection can change data (listings_rw)"],
      [["transactions_r"], "the Etsy connection is missing listings_r; reconnect it with transactions_r listings_r"],
      [[], "the Etsy connection is missing transactions_r listings_r"],
      [{ raw: { scopes: "transactions_r listings_r" } }, "Etsy did not say which scopes the connection has (HTTP 200)"],
      [{ raw: { scopes: ["transactions_r", 5] } }, "Etsy did not say which scopes the connection has"],
      [{ raw: ["transactions_r", "listings_r"] }, "Etsy did not say which scopes the connection has"],
      [{ raw: null }, "Etsy did not say which scopes the connection has"],
      [{ raw: { scopes: ["transactions_r", "listings_r"] }, status: 201 }, "Etsy did not say which scopes the connection has (HTTP 201)"],
      [{ raw: { error: "boom" }, status: 500 }, "Etsy did not say which scopes the connection has (HTTP 500)"],
    ];
    for (const [scopes, message] of cases) {
      const mock = etsyDocMock(shop({ scopes }));
      const error = await etsyClient(options(mock)).listings("active", 0).catch((e: unknown) => e);
      expect(error, JSON.stringify(scopes)).toBeInstanceOf(EtsyConfigError);
      expect((error as Error).message, JSON.stringify(scopes)).toContain(message);
      expect(paths(mock).filter((p) => p.includes("/shops/")), JSON.stringify(scopes)).toEqual([]);
    }
    expect(etsyExtraScopes({ scopes: ["shops_r", "x_w"] })).toEqual(["x_w"]);
    expect(etsyExtraScopes({ scopes: [] })).toEqual([]);
  });

  it("stops when the connection belongs to another shop, and checks again next time", async () => {
    const mock = etsyDocMock(shop({ shopId: "50000002" }));
    const client = etsyClient(options(mock));
    await expect(client.listings("active", 0)).rejects.toThrow(new EtsyConfigError("the Etsy connection belongs to a different shop than ETSY_SHOP_ID"));
    await expect(client.receipts({ by: "created", since: ETSY_EPOCH_MIN, offset: 0 })).rejects.toThrow("belongs to a different shop");
    expect(paths(mock).filter((p) => p.startsWith("GET /v3/application/users/me"))).toHaveLength(2);
    expect(paths(mock).filter((p) => p.includes("/shops/"))).toEqual([]);
    const fetch = (async (url: string) => new Response(JSON.stringify(url.endsWith("/token") ? { access_token: "a".repeat(16) } : url.endsWith("/scopes") ? { scopes: ["transactions_r", "listings_r"] } : [ETSY_TEST_SHOP]), { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(etsyClient({ ...options(mock), fetch }).listings("active", 0)).rejects.toThrow("belongs to a different shop");
  });

  it("reports a refresh Etsy turns down, naming its error code only when it is a plain one", async () => {
    const cases: [() => Response, string, number][] = [
      [() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }), "Etsy turned down the token refresh (HTTP 400, invalid_grant); reconnect the shop to get a new refresh token", 400],
      [() => new Response(JSON.stringify({ error: "Bad thing <script>" }), { status: 401 }), "Etsy turned down the token refresh (HTTP 401); reconnect the shop to get a new refresh token", 401],
      [() => new Response(JSON.stringify({ error: "a".repeat(41) }), { status: 400 }), "Etsy turned down the token refresh (HTTP 400); reconnect", 400],
      [() => new Response(JSON.stringify({ access_token: "a".repeat(15) }), { status: 200 }), "Etsy turned down the token refresh (HTTP 200)", 200],
      [() => new Response(JSON.stringify({ error: "bad <x>" }), { status: 400 }), "Etsy turned down the token refresh (HTTP 400); reconnect", 400],
      [() => new Response(JSON.stringify({ access_token: "a b".repeat(8) }), { status: 200 }), "Etsy turned down the token refresh (HTTP 200)", 200],
      [() => new Response(JSON.stringify({ access_token: 5 }), { status: 200 }), "Etsy turned down the token refresh (HTTP 200)", 200],
      [() => new Response(JSON.stringify(["x"]), { status: 200 }), "Etsy turned down the token refresh (HTTP 200)", 200],
      [() => new Response("<html>", { status: 200 }), "Etsy turned down the token refresh (HTTP 200)", 200],
      [() => new Response(JSON.stringify({ access_token: "a".repeat(16) }), { status: 202 }), "Etsy turned down the token refresh (HTTP 202)", 202],
    ];
    for (const [answer, message, status] of cases) {
      const tokens = memoryTokenStore(REFRESH);
      const error = await etsyClient({ ...options(etsyDocMock(shop())), tokens, fetch: (async () => answer()) as unknown as typeof globalThis.fetch }).listings("active", 0).catch((e: unknown) => e);
      expect(error, message).toBeInstanceOf(EtsyApiError);
      expect(error, message).toMatchObject({ status });
      expect((error as Error).message, message).toContain(message);
      expect(tokens.current).toBe(REFRESH);
    }
    await expect(etsyClient({ ...options(etsyDocMock(shop())), tokens: memoryTokenStore("  ") }).listings("active", 0)).rejects.toThrow(new EtsyConfigError("set ETSY_REFRESH_TOKEN"));
    const wrong = etsyDocMock(shop({ refreshToken: "70000001.otherrefresh" }));
    await expect(etsyClient(options(wrong)).listings("active", 0)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("invalid_grant") });
  });

  it("keeps an access token until five minutes before it runs out, refreshing one at a time", async () => {
    let t = 0;
    const mock = etsyDocMock(shop());
    const client = etsyClient(options(mock, { clock: () => t }));
    await Promise.all([client.listings("active", 0), client.listings("draft", 0), client.receipts({ by: "created", since: ETSY_EPOCH_MIN, offset: 0 })]);
    expect(mock.accessTokens).toHaveLength(1);
    t = 3600_000 - 300_000 - 1;
    await client.listings("active", 0);
    expect(mock.accessTokens).toHaveLength(1);
    t = 3600_000 - 300_000;
    await client.listings("active", 0);
    expect(mock.accessTokens).toHaveLength(2);
    // The shop is checked once per client.
    expect(paths(mock).filter((p) => p.endsWith("/users/me"))).toHaveLength(1);
  });

  it("falls back to ten minutes when Etsy's expires_in can't be read", async () => {
    for (const expires of [undefined, 0, -5, 1.5, "3600", 10_000_000]) {
      let t = 0;
      let refreshes = 0;
      const fetch = (async (url: string) => {
        if (url === ETSY_TOKEN_URL) refreshes++;
        const body = url === ETSY_TOKEN_URL ? { access_token: "a".repeat(16), expires_in: expires } : url.endsWith("/scopes") ? { scopes: ["transactions_r", "listings_r"] } : url.endsWith("/users/me") ? { shop_id: Number(ETSY_TEST_SHOP) } : { results: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const client = etsyClient({ ...options(etsyDocMock(shop())), fetch, clock: () => t });
      await client.listings("active", 0);
      t = 300_000 - 1;
      await client.listings("active", 0);
      expect(refreshes, String(expires)).toBe(1);
      t = 300_000;
      await client.listings("active", 0);
      expect(refreshes, String(expires)).toBe(2);
    }
    let t = 0;
    let refreshes = 0;
    const fetch = (async (url: string) => {
      if (url === ETSY_TOKEN_URL) refreshes++;
      const body = url === ETSY_TOKEN_URL ? { access_token: "a".repeat(16), expires_in: 9_999_999 } : url.endsWith("/scopes") ? { scopes: ["transactions_r", "listings_r"] } : url.endsWith("/users/me") ? { shop_id: Number(ETSY_TEST_SHOP) } : { results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = etsyClient({ ...options(etsyDocMock(shop())), fetch, clock: () => t });
    await client.listings("active", 0);
    t = 9_999_999_000 - 300_001;
    await client.listings("active", 0);
    expect(refreshes).toBe(1);
  });

  it("refreshes once when a token is revoked, and gives up the second time", async () => {
    const mock = etsyDocMock(shop());
    const client = etsyClient(options(mock));
    await client.listings("active", 0);
    mock.revokeTokens();
    expect(await client.listings("active", 0)).toHaveLength(2);
    expect(mock.accessTokens).toHaveLength(2);
    const always = (async (url: string) =>
      new Response(JSON.stringify(url === ETSY_TOKEN_URL ? { access_token: "a".repeat(16) } : url.endsWith("/scopes") ? { scopes: ["transactions_r", "listings_r"] } : url.endsWith("/users/me") ? { shop_id: Number(ETSY_TEST_SHOP) } : {}), {
        status: url.includes("/shops/") ? 401 : 200,
      })) as unknown as typeof globalThis.fetch;
    const calls: string[] = [];
    const counted = (async (url: string, init: RequestInit) => (calls.push(url), always(url, init))) as unknown as typeof globalThis.fetch;
    await expect(etsyClient({ ...options(mock), fetch: counted }).listings("active", 0)).rejects.toMatchObject({ status: 401, message: "Etsy turned down the listings read (HTTP 401): check the connection has transactions_r listings_r" });
    expect(calls.filter((u) => u === ETSY_TOKEN_URL)).toHaveLength(2);
    expect(calls.filter((u) => u.includes("/shops/"))).toHaveLength(2);
  });

  it("doesn't refresh again when the shop check itself is turned down", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/users/me")) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify(url === ETSY_TOKEN_URL ? { access_token: "a".repeat(16) } : { scopes: ["transactions_r", "listings_r"] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await expect(etsyClient({ ...options(etsyDocMock(shop())), fetch }).listings("active", 0)).rejects.toMatchObject({ status: 401, message: expect.stringContaining("account read") });
    expect(calls).toEqual([ETSY_TOKEN_URL, `${ETSY_API_URL}/scopes`, `${ETSY_API_URL}/users/me`]);
  });

  it("waits out rate limits and brief outages, honoring Retry-After up to a minute", async () => {
    const slept: number[] = [];
    const mock = etsyDocMock(shop({ rateLimits: ["7", null, " 2 "] }));
    expect(await etsyClient(options(mock, { sleep: async (ms) => void slept.push(ms) })).listings("active", 0)).toHaveLength(2);
    expect(slept).toEqual([7000, 2000, 2000]);

    for (const status of [500, 502, 503, 504]) {
      const waits: number[] = [];
      let n = 0;
      const fetch = (async () => (n++ < 2 ? new Response("{}", { status, headers: { "retry-after": n === 1 ? "3600" : "x" } }) : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))) as unknown as typeof globalThis.fetch;
      await expect(etsyClient({ ...options(mock), fetch, sleep: async (ms) => void waits.push(ms) }).listings("active", 0)).rejects.toMatchObject({ status: 400 });
      expect(waits, String(status)).toEqual([60_000, 2000]);
    }
    for (const status of [501, 505, 499]) {
      let n = 0;
      const fetch = (async () => (n++, new Response("{}", { status }))) as unknown as typeof globalThis.fetch;
      await expect(etsyClient({ ...options(mock), fetch }).listings("active", 0)).rejects.toMatchObject({ status });
      expect(n, String(status)).toBe(1);
    }
    const waits: number[] = [];
    const longWait = etsyDocMock(shop({ rateLimits: ["1234567", "0"] }));
    await etsyClient(options(longWait, { sleep: async (ms) => void waits.push(ms) })).listings("active", 0);
    expect(waits).toEqual([1000, 2000]);
  });

  it("gives up after its retries, and the next sync picks up", async () => {
    const mock = etsyDocMock(shop({ rateLimits: ["1", "1", "1", "1"] }));
    await expect(etsyClient(options(mock)).receipts({ by: "created", since: ETSY_EPOCH_MIN, offset: 0 })).rejects.toMatchObject({ status: 429, message: "Etsy kept rate-limiting the receipts reads; the next sync picks up from the checkpoint" });
    const once = etsyDocMock(shop({ rateLimits: ["1"] }));
    await expect(etsyClient(options(once, { retries: 0 })).listings("active", 0)).rejects.toMatchObject({ status: 429 });
    const twice = etsyDocMock(shop({ rateLimits: ["1", "1"] }));
    await expect(etsyClient(options(twice, { retries: 1 })).listings("active", 0)).rejects.toMatchObject({ status: 429 });
    const enough = etsyDocMock(shop({ rateLimits: ["1", "1", "1"] }));
    expect(await etsyClient(options(enough)).listings("active", 0)).toHaveLength(2);
  });

  it("sleeps for real when no sleep is given", async () => {
    const mock = etsyDocMock(shop({ rateLimits: ["1"] }));
    const started = Date.now();
    await etsyClient({ keystring: KEYSTRING, sharedSecret: SECRET, shopId: ETSY_TEST_SHOP, tokens: memoryTokenStore(REFRESH), fetch: mock.fetch }).listings("active", 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("turns down other answers and queries it shouldn't send", async () => {
    const answer = (status: number, body: string) =>
      (async (url: string) =>
        url.includes("/shops/") ? new Response(body, { status }) : new Response(JSON.stringify(url === ETSY_TOKEN_URL ? { access_token: "a".repeat(16) } : url.endsWith("/scopes") ? { scopes: ["transactions_r", "listings_r"] } : { shop_id: Number(ETSY_TEST_SHOP) }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const mock = etsyDocMock(shop());
    for (const [status, body, message] of [
      [403, "{}", "Etsy turned down the receipts read (HTTP 403): check the connection has transactions_r listings_r"],
      [404, "{}", "Etsy receipts answered HTTP 404"],
      [201, "{}", "Etsy receipts answered HTTP 201"],
      [200, "<html>", "Etsy receipts did not answer with JSON"],
      [200, "{}", "Etsy receipts answered without a results list"],
      [200, "[]", "Etsy receipts answered without a results list"],
      [200, '{"results":{}}', "Etsy receipts answered without a results list"],
    ] as const) {
      await expect(etsyClient({ ...options(mock), fetch: answer(status, body) }).receipts({ by: "created", since: ETSY_EPOCH_MIN, offset: 0 }), message).rejects.toMatchObject({ name: "EtsyApiError", status, message });
    }
    expect(await etsyClient({ ...options(mock), fetch: answer(200, '{"results":[{"a":1},null,5,[1],{"b":2}]}') }).receipts({ by: "created", since: ETSY_EPOCH_MIN, offset: 0 })).toEqual([{ a: 1 }, { b: 2 }]);

    const client = etsyClient(options(mock));
    const q: EtsyReceiptQuery = { by: "created", since: ETSY_EPOCH_MIN, offset: 0 };
    await expect(client.receipts({ ...q, by: "receipt_id" as never })).rejects.toThrow(new EtsyConfigError("receipts are read by created or updated time"));
    for (const since of [ETSY_EPOCH_MIN - 1, 1.5e9 + 0.5, Number.NaN, 2 ** 53]) await expect(client.receipts({ ...q, since }), String(since)).rejects.toThrow(new EtsyConfigError("since must be epoch seconds from 2000"));
    for (const offset of [-1, 1.5, 2 ** 53]) {
      await expect(client.receipts({ ...q, offset }), String(offset)).rejects.toThrow(new EtsyConfigError("offset must be a whole number from 0"));
      await expect(client.listings("active", offset), String(offset)).rejects.toThrow(new EtsyConfigError("offset must be a whole number from 0"));
    }
    await expect(client.listings("removed" as never, 0)).rejects.toThrow(new EtsyConfigError("not a listing state this connector reads"));
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("Etsy normalizer", () => {
  it("reads ids, times and money, turning down anything else", () => {
    expect([1, 123, "45", 2 ** 53 - 1, "1".repeat(18)].map(etsyId)).toEqual(["1", "123", "45", String(2 ** 53 - 1), "1".repeat(18)]);
    expect([0, -1, 1.5, 2 ** 53, "01", "1".repeat(19), "a", null, undefined].map(etsyId)).toEqual(Array(9).fill(undefined));
    expect(etsyTime(ETSY_EPOCH_MIN)).toBe("2000-01-01T00:00:00.000Z");
    expect(etsyTime(9_999_999_999)).toBe("2286-11-20T17:46:39.000Z");
    expect([ETSY_EPOCH_MIN - 1, 1e10, 1.5e9 + 0.5, "1767225600", null].map(etsyTime)).toEqual(Array(5).fill(undefined));
    expect(etsyCents(money(45_000))).toBe(45_000);
    expect(etsyCents(money(12_345, 1000))).toBe(1235);
    expect(etsyCents(money(12_344, 1000))).toBe(1234);
    expect(etsyCents(money(45, 1))).toBe(4500);
    expect(etsyCents(money(-500))).toBe(-500);
    expect(etsyCents({ amount: 0, divisor: 100 })).toBe(0);
    expect([money(1.5), money(100, 0), money(100, -1), money(100, -100), money(100, 1.5), { amount: "100", divisor: 100 }, { amount: 100 }, money(2 ** 53), null, 5].map(etsyCents)).toEqual(Array(10).fill(null));
    expect(etsyCents({ amount: Number.MAX_SAFE_INTEGER, divisor: 1 })).toBeNull();
  });

  it("names how the buyer paid and finds each line's SKU", () => {
    expect(["cc", "paypal", "apple_pay", "google_pay", "klarna", "ideal", "sofort"].map(etsyPaymentMethod)).toEqual(Array(7).fill("card"));
    expect(["check", "bt", "mo", "other", "CC", undefined].map(etsyPaymentMethod)).toEqual(["check", "wire", "other", "other", "other", "other"]);
    expect(etsySku(" SKU-1 ", 5, 6)).toBe("SKU-1");
    expect(etsySku("x".repeat(150), 5, 6)).toBe("x".repeat(100));
    expect(etsySku(" ", 5, 6)).toBe("etsy-listing-5-6");
    expect(etsySku(null, "5", null)).toBe("etsy-listing-5");
    expect(etsySku(null, 0, 6)).toBeUndefined();
  });

  it("turns a paid receipt into order.updated and sale.completed, without the buyer", () => {
    etsyReceipt.reset();
    const events = etsyReceiptEvents(etsyReceipt.one(), CTX);
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    const [order, sale] = events;
    expect(order).toMatchObject({ occurredAt: "2026-01-01T01:00:00.000Z", receivedAt: RECEIVED, idempotencyKey: "etsy:order:600001:2026-01-01T01:00:00.000Z", id: "etsy_order:600001:2026-01-01T01:00:00.000Z" });
    expect(order!.payload).toEqual({
      orderId: "etsy:receipt:600001",
      locationId: `etsy:shop:${ETSY_TEST_SHOP}`,
      createdAt: "2026-01-01T01:00:00.000Z",
      status: "PAID",
      paid: true,
      shipped: false,
      cancelled: false,
      channel: "online",
      marketplace: "etsy",
      currency: "USD",
      totalCents: 48_600,
      refundedCents: 0,
      lineCount: 1,
      linesComplete: true,
    });
    expect(sale).toMatchObject({ idempotencyKey: "etsy:sale:600001", occurredAt: "2026-01-01T01:00:00.000Z" });
    expect(sale!.payload).toEqual({ saleId: "etsy:receipt:600001", channel: "online", lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 45_000, discountCents: 0 }], totalCents: 48_600, payments: [{ method: "card", amountCents: 48_600 }] });
    const kept = JSON.stringify(events);
    for (const gone of ["400001", "customer1@example.test", "Test Customer", "Test Street", "Testville", "10001", "engrave", "seller@example.test", "Personalization", "stacking"]) expect(kept, gone).not.toContain(gone);
  });

  it("reads Etsy's older time fields and every status", () => {
    const base = { receipt_id: 7, is_paid: false, grandtotal: money(100), transactions: [] };
    const order = (r: Record<string, unknown>) => etsyReceiptEvents({ ...base, ...r }, CTX)[0]!;
    expect(order({ create_timestamp: BASE, update_timestamp: BASE + 60 })).toMatchObject({ occurredAt: "2026-01-01T00:01:00.000Z", payload: { createdAt: "2026-01-01T00:00:00.000Z" } });
    expect(order({ created_timestamp: BASE, create_timestamp: BASE + 1 }).payload.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(order({ updated_timestamp: BASE, update_timestamp: BASE + 1 }).occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(order({}).idempotencyKey).toBe("etsy:order:7:unknown");
    const statuses = ["paid", "completed", "open", "payment processing", "canceled", "fully refunded", "partially refunded", " Paid ", "shipped", 5];
    expect(statuses.map((status) => order({ status }).payload.status)).toEqual(["PAID", "COMPLETED", "OPEN", "PAYMENT_PROCESSING", "CANCELED", "FULLY_REFUNDED", "PARTIALLY_REFUNDED", "PAID", null, null]);
    expect(order({ status: "canceled" }).payload.cancelled).toBe(true);
    expect(order({ is_shipped: "true", is_paid: "true" }).payload).toMatchObject({ shipped: false, paid: false });
    expect(order({ grandtotal: { amount: 1, divisor: 1, currency_code: "usd" } }).payload).not.toHaveProperty("currency");
    expect(order({ transactions: [{}, 5, {}] }).payload.lineCount).toBe(2);
    expect([0, "x", null].map((receipt_id) => etsyReceiptEvents({ ...base, receipt_id }, CTX))).toEqual([[], [], []]);
    expect(etsyReceiptEvents(null as never, CTX)).toEqual([]);
  });

  it("counts a sale only once it is paid, not cancelled, and every line is readable", () => {
    etsyReceipt.reset();
    const r = etsyReceipt.one();
    const types = (over: Record<string, unknown>) => etsyReceiptEvents({ ...r, ...over }, CTX).map((e) => e.type);
    const line = (r.transactions as Record<string, unknown>[])[0]!;
    expect(types({ is_paid: false })).toEqual(["order.updated"]);
    expect(types({ status: "canceled" })).toEqual(["order.updated"]);
    expect(types({ grandtotal: money(0) })).toEqual(["order.updated"]);
    expect(types({ grandtotal: null })).toEqual(["order.updated"]);
    expect(types({ transactions: [] })).toEqual(["order.updated"]);
    for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: "1" }, { price: money(-1) }, { price: null }, { sku: null, listing_id: null }, { shop_coupon: -1 }]) {
      expect(types({ transactions: [line, { ...line, ...bad }] }), JSON.stringify(bad)).toEqual(["order.updated"]);
    }
    expect(types({ status: "completed", is_shipped: true })).toEqual(["order.updated", "sale.completed"]);
    const sale = etsyReceiptEvents({ ...r, payment_method: "bt", transactions: [{ ...line, quantity: 2, price: money(10_000), shop_coupon: 12.345, sku: null }, { ...line, shop_coupon: Number.NaN, shop_coupon_x: 1 }, { ...line, shop_coupon: "5" }] }, CTX)[1]!;
    expect(sale.payload).toMatchObject({
      lines: [{ sku: "etsy-listing-900001-800001", quantity: 2, unitPriceCents: 10_000, discountCents: 1235 }, { discountCents: 0 }, { discountCents: 0 }],
      payments: [{ method: "wire", amountCents: 48_600 }],
    });
    expect(etsyReceiptEvents({ ...r, transactions: [{ ...line, price: money(0) }] }, CTX).map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
  });

  it("returns a fully refunded receipt's lines, and only notes a partial refund", () => {
    etsyReceipt.reset();
    const r = etsyReceipt.one();
    const line = (r.transactions as Record<string, unknown>[])[0]!;
    const refunds = [{ amount: money(30_000), created_timestamp: BASE + 7200 }, { amount: money(18_600), created_timestamp: BASE + 9000 }, { amount: money(-5), created_timestamp: BASE + 99_999 }, { amount: "x", created_timestamp: "y" }];
    const full = etsyReceiptEvents({ ...r, status: "fully refunded", refunds, transactions: [{ ...line, quantity: 2, shop_coupon: 10 }] }, CTX);
    expect(full.map((e) => e.type)).toEqual(["order.updated", "sale.completed", "sale.returned"]);
    expect(full[0]!.payload.refundedCents).toBe(48_600);
    expect(full[2]).toMatchObject({ idempotencyKey: "etsy:return:600001", occurredAt: new Date((BASE + 99_999) * 1000).toISOString() });
    expect(full[2]!.payload).toEqual({ saleId: "etsy:receipt:600001", returnId: "etsy:return:600001", lines: [{ sku: "SKU-TEST-0001", quantity: 2, refundCents: 89_000 }] });
    const noDates = etsyReceiptEvents({ ...r, status: "fully refunded", refunds: [{ amount: money(1) }] }, CTX);
    expect(noDates[2]!.occurredAt).toBe("2026-01-01T01:00:00.000Z");
    const partial = etsyReceiptEvents({ ...r, status: "partially refunded", refunds: [{ amount: money(5_000) }] }, CTX);
    expect(partial.map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    expect(partial[0]!.payload.refundedCents).toBe(5_000);
    expect(etsyReceiptEvents({ ...r, status: "fully refunded", transactions: [{ ...line, quantity: 0 }] }, CTX).map((e) => e.type)).toEqual(["order.updated"]);
    expect(etsyReceiptEvents({ ...r, status: "fully refunded", is_paid: false }, CTX).map((e) => e.type)).toEqual(["order.updated", "sale.returned"]);
    expect(etsyReceiptEvents({ ...r, status: "fully refunded", transactions: [] }, CTX).map((e) => e.type)).toEqual(["order.updated"]);
  });

  it("turns a listing into product.updated with its products, and their stock into inventory.counted", () => {
    etsyListing.reset();
    const events = etsyListingEvents(etsyListing.one(), CTX);
    expect(events.map((e) => e.type)).toEqual(["product.updated", "inventory.counted"]);
    const [product, count] = events;
    expect(product).toMatchObject({ occurredAt: "2026-01-01T00:01:00.000Z", receivedAt: RECEIVED });
    expect(product!.idempotencyKey).toMatch(/^etsy:product:900001:[0-9a-f]{16}$/);
    expect(product!.payload).toEqual({
      productId: "etsy:listing:900001",
      title: "Test 14k stacking ring 1",
      status: "ACTIVE",
      vendor: null,
      productType: null,
      tags: [],
      variants: [{ variantId: "etsy:product:800001", sku: "SKU-TEST-0001", priceCents: 45_000, inventoryQuantity: 3 }],
    });
    expect(count).toMatchObject({ idempotencyKey: "etsy:count:800001:3:2026-01-01T00:01:00.000Z", occurredAt: "2026-01-01T00:01:00.000Z" });
    expect(count!.payload).toEqual({ sku: "SKU-TEST-0001", onHand: 3, variantId: "etsy:product:800001", locationId: `etsy:shop:${ETSY_TEST_SHOP}` });
    const kept = JSON.stringify(events);
    for (const gone of ["seller@example.test", "Handmade", "14k gold", "etsy.com/listing", "\"test\""]) expect(kept, gone).not.toContain(gone);
  });

  it("reads every listing state and each product's offerings", () => {
    const listing = (over: Record<string, unknown>) => ({ listing_id: 5, ...over });
    const status = (state: unknown) => etsyListingEvents(listing({ state }), CTX)[0]!.payload.status;
    expect(["active", "sold_out", "draft", "inactive", "expired", "removed", undefined].map(status)).toEqual(["ACTIVE", "ACTIVE", "DRAFT", "ARCHIVED", "ARCHIVED", "ARCHIVED", "ARCHIVED"]);
    const bare = etsyListingEvents(listing({ title: " ", last_modified_timestamp: BASE }), CTX);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatchObject({ occurredAt: "2026-01-01T00:00:00.000Z", payload: { title: "Etsy listing 5", variants: [] } });
    expect(etsyListingEvents(listing({}), CTX)[0]!.occurredAt).toBe(RECEIVED);
    expect(etsyListingEvents(listing({ updated_timestamp: BASE, last_modified_timestamp: BASE + 5 }), CTX)[0]!.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(etsyListingEvents(listing({ title: "t".repeat(300) }), CTX)[0]!.payload.title).toBe("t".repeat(200));
    const products = [
      { product_id: 1, sku: "A", offerings: [{ quantity: 2, price: money(100) }, { quantity: 3, price: money(200), is_enabled: true }, { quantity: 50, is_enabled: false }, { quantity: 70, is_deleted: true }] },
      { product_id: 2, sku: "", offerings: [] },
      { product_id: 3, is_deleted: true, offerings: [{ quantity: 1 }] },
      { product_id: "x", offerings: [{ quantity: 1 }] },
      { product_id: 4, offerings: [{ quantity: 1 }, { quantity: -1 }] },
      { product_id: 6, offerings: [{ quantity: 1.5 }] },
      { product_id: 7, offerings: [{ quantity: 0, price: money(0) }], is_deleted: false },
      5,
    ];
    const events = etsyListingEvents(listing({ updated_timestamp: BASE, inventory: { products } }), CTX);
    expect(events[0]!.payload.variants).toEqual([
      { variantId: "etsy:product:1", sku: "A", priceCents: 100, inventoryQuantity: 5 },
      { variantId: "etsy:product:2", sku: "etsy-listing-5-2", priceCents: null, inventoryQuantity: 0 },
      { variantId: "etsy:product:4", sku: "etsy-listing-5-4", priceCents: null, inventoryQuantity: null },
      { variantId: "etsy:product:6", sku: "etsy-listing-5-6", priceCents: null, inventoryQuantity: null },
      { variantId: "etsy:product:7", sku: "etsy-listing-5-7", priceCents: 0, inventoryQuantity: 0 },
    ]);
    expect(events.slice(1).map((e) => e.idempotencyKey)).toEqual(["etsy:count:1:5:2026-01-01T00:00:00.000Z", "etsy:count:2:0:2026-01-01T00:00:00.000Z", "etsy:count:4:unknown:2026-01-01T00:00:00.000Z", "etsy:count:6:unknown:2026-01-01T00:00:00.000Z", "etsy:count:7:0:2026-01-01T00:00:00.000Z"]);
    expect(events.slice(1).map((e) => e.payload.onHand)).toEqual([5, 0, null, null, 0]);
    expect(etsyListingEvents(listing({ inventory: { products: "x" } }), CTX)[0]!.payload.variants).toEqual([]);
    expect([0, "a", null].map((listing_id) => etsyListingEvents({ listing_id }, CTX))).toEqual([[], [], []]);
    expect(etsyListingEvents(null as never, CTX)).toEqual([]);
  });

  it("keys a listing by what was kept, so only a change makes a new version", () => {
    etsyListing.reset();
    const l = etsyListing.one();
    const key = (over: Record<string, unknown>) => etsyListingEvents({ ...l, ...over }, CTX)[0]!.idempotencyKey;
    expect(key({})).toBe(key({ description: "changed", tags: ["new"], num_favorers: 9 }));
    expect(new Set([key({}), key({ title: "Other" }), key({ state: "draft" }), key({ inventory: { products: [] } })]).size).toBe(4);
    expect(etsyListingEvents(l, { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" })[0]!.idempotencyKey).toBe(key({}));
  });
});

describe("Etsy cursor", () => {
  const good: EtsyCursor = { pass: "incremental", step: 5, offset: 3, since: 1_794_000_000, nextSince: 1_794_100_000 };
  it("reads a checkpoint it wrote and nothing else", () => {
    expect(parseEtsyCursor(null)).toBeNull();
    expect(parseEtsyCursor(JSON.stringify({ ...good, extra: 1 }))).toEqual(good);
    expect(parseEtsyCursor(JSON.stringify({ ...good, pass: "historical", step: 6, offset: 0, since: ETSY_EPOCH_MIN }))).toMatchObject({ step: 6, since: ETSY_EPOCH_MIN });
    const bad = [
      "{", "null", "5", "[]",
      ...[{ pass: "full" }, { step: -1 }, { step: 7 }, { step: 1.5 }, { offset: -1 }, { offset: 1.5 }, { offset: "0" }, { since: ETSY_EPOCH_MIN - 1 }, { since: 1.5e9 + 0.5 }, { since: "1794000000" }, { nextSince: ETSY_EPOCH_MIN - 1 }, { nextSince: null }].map((o) => JSON.stringify({ ...good, ...o })),
    ];
    for (const raw of bad) expect(() => parseEtsyCursor(raw), raw).toThrow("Etsy checkpoint is not in the expected shape");
  });
});

describe("Etsy connector", () => {
  it("passes the shared sync check", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(etsyDocMock(shop())), expected: { ingested: 2 * 2 + 3 * 2 } });
    expect(result.full.batches).toBe(ETSY_LISTING_STATES.length + 1);
    expect(parseEtsyCursor(result.full.cursor)).toEqual({ pass: "historical", step: 6, offset: 0, since: 1_636_556_400, nextSince: NOW_S - ETSY_OVERLAP_S });
  });

  it("reads every listing state, then five years of receipts, then stops for good", async () => {
    etsyReceipt.reset();
    etsyListing.reset();
    const old = etsyReceipt.one({ created_timestamp: 1_600_000_000, updated_timestamp: 1_600_000_000 });
    const data = shop();
    data.receipts.push(old);
    data.listings.push(etsyListing.one({ state: "draft" }), etsyListing.one({ state: "expired" }));
    const mock = etsyDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4 * 2 + 3 * 2);
    expect(mock.reads.map((r) => (r.list === "listings" ? r.query.state : r.query.min_created))).toEqual(["active", "sold_out", "inactive", "expired", "draft", String(1_636_556_400)]);
    expect(memory.events.filter((e) => e.type === "product.updated").map((e) => e.payload.status)).toEqual(["ACTIVE", "ACTIVE", "ARCHIVED", "DRAFT"]);
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(6);
  });

  it("pages listings 100 at a time, and receipts from the time the last page reached", async () => {
    etsyListing.reset();
    etsyReceipt.reset();
    const listings = etsyListing.many(150);
    // 250 receipts: the 100th and 101st to 105th share one second, so the next page starts past those already read.
    const receipts = Array.from({ length: 250 }, (_, i) => etsyReceipt.one({ created_timestamp: BASE + (i < 99 ? i : i < 105 ? 99 : i), updated_timestamp: BASE }));
    const mock = etsyDocMock(shop({ listings, receipts }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(mock.reads.filter((r) => r.list === "listings" && r.query.state === "active").map((r) => r.query.offset)).toEqual(["0", "100"]);
    const receiptReads = mock.reads.filter((r) => r.list === "receipts").map((r) => [Number(r.query.min_created) - BASE, r.query.offset]);
    expect(receiptReads).toEqual([[1_636_556_400 - BASE, "0"], [99, "1"], [199, "1"]]);
    const sales = batches.flatMap((b) => b.events).filter((e) => (e as { type: string }).type === "sale.completed");
    expect(new Set(sales.map((e) => (e as { idempotencyKey: string }).idempotencyKey)).size).toBe(250);
    expect(batches.map((b) => parseEtsyCursor(b.cursor)!.step)).toEqual([0, 1, 2, 3, 4, 5, 5, 5, 6]);
  });

  it("moves past a full page of receipts that share one second by offset", async () => {
    etsyReceipt.reset();
    const receipts = Array.from({ length: 230 }, () => etsyReceipt.one({ created_timestamp: BASE, updated_timestamp: BASE }));
    const mock = etsyDocMock(shop({ receipts, listings: [] }));
    const cursor = JSON.stringify({ pass: "historical", step: 5, offset: 0, since: BASE, nextSince: BASE });
    const batches = await drain(connector(mock).historicalImport({ cursor } as never));
    expect(mock.reads.map((r) => [r.query.min_created, r.query.offset])).toEqual([[String(BASE), "0"], [String(BASE), "100"], [String(BASE), "200"]]);
    expect(batches.map((b) => b.events.length)).toEqual([200, 200, 60]);
    expect(parseEtsyCursor(batches.at(-1)!.cursor)).toMatchObject({ step: 6, offset: 0 });
    // A page one short of full is the last.
    const short = etsyDocMock(shop({ receipts: receipts.slice(0, ETSY_PAGE_SIZE - 1), listings: [] }));
    await drain(connector(short).historicalImport({ cursor } as never));
    expect(short.reads).toHaveLength(1);
  });

  it("stops at a full page of receipts it can't move past", async () => {
    const page = (time: unknown) => Array.from({ length: ETSY_PAGE_SIZE }, (_, i) => ({ receipt_id: i + 1, created_timestamp: time }));
    for (const time of [undefined, "1767225600", BASE - 1]) {
      const client: EtsyClient = { listings: async () => [], receipts: async () => page(time) };
      const cursor = JSON.stringify({ pass: "historical", step: 5, offset: 0, since: BASE, nextSince: BASE });
      await expect(drain(etsyConnector({ ...options(etsyDocMock(shop())), client, now: NOW }).historicalImport({ cursor } as never)), String(time)).rejects.toThrow("Etsy answered a full page of receipts without a readable time in order");
    }
    const mixed = page(BASE + 10);
    mixed[99] = { receipt_id: 100, created_timestamp: "x" };
    const client: EtsyClient = { listings: async () => [], receipts: async () => mixed };
    await expect(drain(etsyConnector({ ...options(etsyDocMock(shop())), client, now: NOW }).historicalImport({ cursor: JSON.stringify({ pass: "historical", step: 5, offset: 0, since: BASE, nextSince: BASE }) } as never))).rejects.toThrow("without a readable time");
  });

  it("uses created times for the import and updated times after, the older field names too", async () => {
    const asked: EtsyReceiptQuery[] = [];
    const full = (field: string) => Array.from({ length: ETSY_PAGE_SIZE }, (_, i) => ({ receipt_id: i + 1, [field]: BASE + 50 }));
    let answers: Record<string, unknown>[][] = [];
    const client: EtsyClient = { listings: async () => [], receipts: async (q) => (asked.push(q), answers.shift() ?? []) };
    const make = () => etsyConnector({ ...options(etsyDocMock(shop())), client, now: NOW });
    answers = [full("create_timestamp")];
    await drain(make().historicalImport({ cursor: JSON.stringify({ pass: "historical", step: 5, offset: 0, since: BASE, nextSince: BASE }) } as never));
    answers = [full("update_timestamp")];
    await drain(make().incrementalSync({ cursor: JSON.stringify({ pass: "incremental", step: 5, offset: 0, since: BASE, nextSince: BASE }) } as never));
    answers = [[...full("updated_timestamp").slice(1), { receipt_id: 999, updated_timestamp: BASE + 50, update_timestamp: BASE + 70 }]];
    await drain(make().incrementalSync({ cursor: JSON.stringify({ pass: "incremental", step: 5, offset: 0, since: BASE, nextSince: BASE }) } as never));
    expect(asked).toEqual([
      { by: "created", since: BASE, offset: 0 }, { by: "created", since: BASE + 50, offset: 100 },
      { by: "updated", since: BASE, offset: 0 }, { by: "updated", since: BASE + 50, offset: 100 },
      { by: "updated", since: BASE, offset: 0 }, { by: "updated", since: BASE + 50, offset: 100 },
    ]);
  });

  it("syncs what changed since the last pass started, less a quarter hour", async () => {
    const mock = etsyDocMock(shop());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const since = () => mock.reads.filter((r) => r.list === "receipts").map((r) => Number(r.query.min_last_modified));
    // With no checkpoint of its own, it looks back two days.
    expect(since()).toEqual([NOW_S - 48 * 3600]);
    const later = () => new Date(NOW().getTime() + 3_600_000);
    await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(since()).toEqual([NOW_S - 48 * 3600, NOW_S - 900, NOW_S + 3600 - 900]);
    expect(ETSY_OVERLAP_S).toBe(900);
  });

  it("starts syncing from where the import began, and resumes an interrupted pass", async () => {
    const mock = etsyDocMock(shop());
    const imported = JSON.stringify({ pass: "historical", step: 6, offset: 0, since: 1_636_556_400, nextSince: 1_794_000_000 });
    const batches = await drain(connector(mock).incrementalSync({ cursor: imported } as never));
    expect(mock.reads.filter((r) => r.list === "receipts")[0]!.query.min_last_modified).toBe("1794000000");
    expect(parseEtsyCursor(batches.at(-1)!.cursor)).toEqual({ pass: "incremental", step: 6, offset: 0, since: 1_794_000_000, nextSince: NOW_S - 900 });

    // An interrupted import isn't finished, so an incremental sync looks back two days instead.
    const fresh = etsyDocMock(shop());
    await drain(connector(fresh).incrementalSync({ cursor: imported.replace('"step":6', '"step":2') } as never));
    expect(fresh.reads.filter((r) => r.list === "receipts")[0]!.query.min_last_modified).toBe("1794000000");

    const resumed = etsyDocMock(shop());
    await drain(connector(resumed).historicalImport({ cursor: JSON.stringify({ pass: "historical", step: 3, offset: 200, since: 1_700_000_000, nextSince: 1_700_000_100 }) } as never));
    expect(resumed.reads.map((r) => r.query.state ?? r.query.min_created)).toEqual(["expired", "draft", "1700000000"]);
    expect(resumed.reads[0]!.query.offset).toBe("200");

    const finishedInc = etsyDocMock(shop());
    await drain(connector(finishedInc).historicalImport({ cursor: JSON.stringify({ pass: "incremental", step: 6, offset: 0, since: 1_700_000_000, nextSince: 1_700_000_100 }) } as never));
    expect(finishedInc.reads.at(-1)!.query.min_created).toBe("1636556400");
  });

  it("takes the history and lookback it is given, never before 2000", async () => {
    const mock = etsyDocMock(shop());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    await drain(connector(mock, { incrementalLookbackHours: 24 * 10 }).incrementalSync({ cursor: null } as never));
    await drain(connector(mock, { historyYears: 40 }).historicalImport({ cursor: null } as never));
    await drain(connector(mock, { incrementalLookbackHours: 24 * 365 * 40 }).incrementalSync({ cursor: null } as never));
    expect(mock.reads.filter((r) => r.list === "receipts").map((r) => r.query.min_created ?? r.query.min_last_modified)).toEqual([String(NOW_S - 365 * 86_400), String(NOW_S - 240 * 3600), String(ETSY_EPOCH_MIN), String(ETSY_EPOCH_MIN)]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => connector(mock, { historyYears: bad }), String(bad)).toThrow("historyYears must be a positive whole number");
      expect(() => connector(mock, { incrementalLookbackHours: bad }), String(bad)).toThrow("incrementalLookbackHours must be a positive whole number");
    }
  });

  it("names the shop on its events and dates them when the pass ran", async () => {
    const client: EtsyClient = { listings: async (state) => (state === "active" ? [{ listing_id: 1, inventory: { products: [{ product_id: 2, offerings: [{ quantity: 1 }] }] } }] : []), receipts: async () => [{ receipt_id: 3 }] };
    const batches = await drain(etsyConnector({ ...options(etsyDocMock(shop())), shopId: " 77 ", client, now: NOW }).historicalImport({ cursor: null } as never));
    const events = batches.flatMap((b) => b.events) as { receivedAt: string; payload: Record<string, unknown> }[];
    expect(events.map((e) => e.payload.locationId)).toEqual([undefined, "etsy:shop:77", "etsy:shop:77"]);
    expect(events.every((e) => e.receivedAt === RECEIVED)).toBe(true);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(ETSY_WRITES.map((w) => [w.integration, w.name])).toEqual([["etsy", "update_listing_inventory"], ["etsy", "mark_receipt_shipped"]]);
    const c = connector(etsyDocMock(shop()));
    expect(c.source).toBe("etsy");
    expect(c.writes).toBe(ETSY_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "update_listing_inventory", integration: "etsy", outcome: "refused" }, { action: "mark_receipt_shipped", integration: "etsy", outcome: "refused" }]);
  });
});
