import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  LIGHTSPEED_MOCK_READ_SCOPES,
  LIGHTSPEED_TEST_PREFIX,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  lightspeedCustomer,
  lightspeedDocMock,
  lightspeedInventory,
  lightspeedProduct,
  lightspeedSale,
  lightspeedTestId,
  type LightspeedMockData,
} from "@karatos/connector-testkit";
import {
  LIGHTSPEED_API_VERSION,
  LIGHTSPEED_COLLECTIONS,
  LIGHTSPEED_CUSTOMER_PREFIX,
  LIGHTSPEED_INVENTORY_PAGE,
  LIGHTSPEED_READ_SCOPES,
  LIGHTSPEED_STREAMS,
  LIGHTSPEED_WRITES,
  LightspeedApiError,
  LightspeedConfigError,
  lightspeedCents,
  lightspeedClient,
  lightspeedConnector,
  lightspeedCustomerEvent,
  lightspeedCustomerRef,
  lightspeedId,
  lightspeedInventoryEvent,
  lightspeedPaymentMethod,
  lightspeedProductEvent,
  lightspeedQuantity,
  lightspeedRetryAfter,
  lightspeedSaleEvents,
  lightspeedTime,
  lightspeedVersion,
  lightspeedWriteScopes,
  memoryTokenStore,
  parseLightspeedCursor,
  squareCustomerRef,
  type LightspeedClient,
  type LightspeedContext,
  type LightspeedCursor,
  type LightspeedRecord,
} from "../src/index.js";

// Shaped like a Lightspeed app's client ID and secret and a customer key, assembled so no scanner mistakes them for real ones.
const ID = ["test", "0".repeat(28)].join("");
const SECRET = ["test", "1".repeat(36)].join("");
const KEY = ["test", "2".repeat(60)].join("");
const SEED = ["testrefresh", "3".repeat(13)].join("");
const NOW = new Date("2026-11-10T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const HOST = `https://${LIGHTSPEED_TEST_PREFIX}.retail.lightspeed.app`;
const noSleep = async () => {};

const PRODUCTS = lightspeedProduct.many(3);
const INVENTORY = lightspeedInventory.many(3);
const CUSTOMERS = lightspeedCustomer.many(2);
const SALES = lightspeedSale.many(2);
const SALE = SALES[0]!;
const pid = (n: number) => lightspeedTestId("a", n);

function store(over: Partial<LightspeedMockData> = {}) {
  return lightspeedDocMock({ clientId: ID, clientSecret: SECRET, refreshToken: SEED, products: PRODUCTS, inventory: INVENTORY, customers: CUSTOMERS, sales: SALES, ...over });
}

function connector(mock = store(), over: Record<string, unknown> = {}) {
  return lightspeedConnector({ domainPrefix: LIGHTSPEED_TEST_PREFIX, clientId: ID, clientSecret: SECRET, customerKey: KEY, tokens: memoryTokenStore(SEED), fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...over });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

type Ev = { type: string; occurredAt?: string; idempotencyKey: string; payload: Record<string, unknown> };
const eventsOf = (out: SourceBatch[]) => out.flatMap((b) => b.events as Ev[]);
const cursorOf = (b: SourceBatch) => JSON.parse(b.cursor!) as LightspeedCursor;

/** A fetch that answers from a list of responses, recording what was asked. */
function scripted(responses: (() => Response)[]) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const raw = (status: number, text: string) => () => new Response(text, { status });
const token = (over: Record<string, unknown> = {}) =>
  json(200, { access_token: "testaccess00000000000001", token_type: "Bearer", expires_in: 604_800, refresh_token: "testrefresh0000000000002", domain_prefix: LIGHTSPEED_TEST_PREFIX, scope: LIGHTSPEED_MOCK_READ_SCOPES, ...over });
const page = (data: unknown[], max: number | null) => json(200, { data, version: { min: max, max } });

function client(fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  const tokens = memoryTokenStore(SEED);
  return { tokens, client: lightspeedClient({ domainPrefix: LIGHTSPEED_TEST_PREFIX, clientId: ID, clientSecret: SECRET, tokens, fetch, sleep: noSleep, clock: () => NOW.getTime(), ...over }) };
}

const ctx = (over: Partial<LightspeedContext> = {}): LightspeedContext => ({ receivedAt: RECEIVED, customerRef: (id) => lightspeedCustomerRef(KEY, id), sku: (id) => `lightspeed-product-${id}`, ...over });

describe("the Lightspeed client", () => {
  it("refreshes with the form Lightspeed documents, saves the new refresh token, and reads with GETs only", async () => {
    const { fetch, sent } = scripted([token(), page([{ id: "x" }, 3, null, [1]], 7)]);
    const { client: c, tokens } = client(fetch);
    expect(await c.list("sales", 5)).toEqual({ data: [{ id: "x" }], max: 7 });
    expect([sent[0]!.url, sent[0]!.init?.method]).toEqual([`${HOST}/api/1.0/token`, "POST"]);
    expect(new Headers(sent[0]!.init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(sent[0]!.init?.body)))).toEqual({ grant_type: "refresh_token", refresh_token: SEED, client_id: ID, client_secret: SECRET });
    expect(tokens.current).toBe("testrefresh0000000000002");
    expect([sent[1]!.url, sent[1]!.init?.method]).toEqual([`${HOST}/api/${LIGHTSPEED_API_VERSION}/sales?after=5`, "GET"]);
    expect(new Headers(sent[1]!.init?.headers).get("authorization")).toBe("Bearer testaccess00000000000001");
    expect(sent[1]!.init?.body).toBeUndefined();
    expect(LIGHTSPEED_API_VERSION).toBe("2026-10");
    expect(LIGHTSPEED_READ_SCOPES).toEqual(["products:read", "inventory:read", "customers:read", "sales:read"]);
    expect(LIGHTSPEED_COLLECTIONS).toEqual(["products", "customers", "sales"]);
  });

  it("lower-cases and trims the domain prefix and the app's id and secret", async () => {
    const { fetch, sent } = scripted([token(), page([], null)]);
    await client(fetch, { domainPrefix: " TestStore ", clientId: ` ${ID} `, clientSecret: ` ${SECRET}\n` }).client.list("products", 0);
    expect(sent[1]!.url).toBe(`${HOST}/api/2026-10/products?after=0`);
    expect(Object.fromEntries(new URLSearchParams(String(sent[0]!.init?.body)))).toMatchObject({ client_id: ID, client_secret: SECRET });
  });

  it("turns down settings that aren't a store prefix, client id or secret", () => {
    const fetch = scripted([]).fetch;
    for (const domainPrefix of ["", "test.retail.lightspeed.app", "https://teststore", "-test", "test-", "te_st", "a".repeat(64), undefined]) {
      expect(() => client(fetch, { domainPrefix }), String(domainPrefix)).toThrow(LightspeedConfigError);
    }
    expect(() => client(fetch, { domainPrefix: "a".repeat(63) })).not.toThrow();
    expect(() => client(fetch, { domainPrefix: "a" })).not.toThrow();
    expect(() => client(fetch, { domainPrefix: "my-store-2" })).not.toThrow();
    for (const over of [{ clientId: "" }, { clientId: "short" }, { clientSecret: "short" }, { clientSecret: "has space in" }, { clientId: undefined }, { clientSecret: undefined }]) {
      expect(() => client(fetch, over), JSON.stringify(over)).toThrow("set LIGHTSPEED_CLIENT_ID and LIGHTSPEED_CLIENT_SECRET");
    }
    expect(() => client(fetch, { clientId: "a".repeat(8), clientSecret: "b".repeat(8) })).not.toThrow();
    expect(() => client(fetch, { clientId: "a".repeat(257) })).toThrow(LightspeedConfigError);
    expect(() => client(fetch, { clientSecret: "a".repeat(513) })).toThrow(LightspeedConfigError);
    expect(() => client(fetch, { clientId: "a".repeat(256), clientSecret: "a".repeat(512) })).not.toThrow();
  });

  it("asks for a refresh token before sending anything", async () => {
    const { fetch, sent } = scripted([]);
    const c = lightspeedClient({ domainPrefix: LIGHTSPEED_TEST_PREFIX, clientId: ID, clientSecret: SECRET, tokens: memoryTokenStore("  "), fetch });
    await expect(c.list("sales", 0)).rejects.toThrow("set LIGHTSPEED_REFRESH_TOKEN");
    expect(sent).toEqual([]);
  });

  it("stops on a connection holding any scope beyond reading, after keeping the new refresh token", async () => {
    for (const scope of ["sales:read sales:write", "products:read products:write:costs", "admin", "inventory:read  customers:write"]) {
      const { fetch, sent } = scripted([token({ scope })]);
      const { client: c, tokens } = client(fetch);
      const error = await c.list("sales", 0).catch((e: unknown) => e);
      expect(error, scope).toBeInstanceOf(LightspeedConfigError);
      expect(String(error)).toContain("can change data");
      expect(String(error)).toContain("products:read inventory:read customers:read sales:read");
      expect(sent).toHaveLength(1);
      expect(tokens.current).toBe("testrefresh0000000000002");
    }
    const { fetch } = scripted([token({ scope: "sales:read products:read:costs customers:read" }), page([], null)]);
    await expect(client(fetch).client.list("sales", 0)).resolves.toEqual({ data: [], max: null });
  });

  it("stops when Lightspeed doesn't say which scopes the connection has", async () => {
    for (const scope of [undefined, "", "  ", 3, ["sales:read"]]) {
      const { fetch, sent } = scripted([token({ scope })]);
      await expect(client(fetch).client.list("sales", 0), String(scope)).rejects.toThrow("did not say which scopes");
      expect(sent).toHaveLength(1);
    }
  });

  it("stops on a token for another store", async () => {
    const { fetch, sent } = scripted([token({ domain_prefix: "otherstore" })]);
    await expect(client(fetch).client.list("sales", 0)).rejects.toThrow("different store");
    expect(sent).toHaveLength(1);
    const same = scripted([token({ domain_prefix: "TESTSTORE" }), page([], null)]);
    await expect(client(same.fetch).client.list("sales", 0)).resolves.toEqual({ data: [], max: null });
    const none = scripted([token({ domain_prefix: undefined }), page([], null)]);
    await expect(client(none.fetch).client.list("sales", 0)).resolves.toEqual({ data: [], max: null });
  });

  it("keeps the old refresh token when Lightspeed gives none, and trims the new one", async () => {
    const kept = scripted([token({ refresh_token: undefined }), page([], null)]);
    const a = client(kept.fetch);
    await a.client.list("sales", 0);
    expect(a.tokens.current).toBe(SEED);
    const blank = scripted([token({ refresh_token: "  " }), page([], null)]);
    const b = client(blank.fetch);
    await b.client.list("sales", 0);
    expect(b.tokens.current).toBe(SEED);
    const padded = scripted([token({ refresh_token: " testrefresh0000000000009 " }), page([], null)]);
    const c = client(padded.fetch);
    await c.client.list("sales", 0);
    expect(c.tokens.current).toBe("testrefresh0000000000009");
  });

  it("stops on a refresh Lightspeed turned down, naming its error code but never the token", async () => {
    const { fetch } = scripted([json(400, { error: "invalid_grant", error_description: SEED })]);
    const error = await client(fetch).client.list("sales", 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LightspeedApiError);
    expect(error).toMatchObject({ status: 400 });
    expect(String(error)).toContain("HTTP 400, invalid_grant");
    expect(String(error)).toContain("reconnect the store");
    expect(String(error)).not.toContain(SEED);
    for (const body of [raw(401, "nope"), json(400, { error: "Not A Code" }), json(400, { error: "x".repeat(41) }), json(200, { access_token: "short" }), json(200, { access_token: 5 }), json(200, { access_token: "has a space in it ok" }), json(200, ["x"])]) {
      const e = await client(scripted([body]).fetch).client.list("sales", 0).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LightspeedApiError);
      expect(String(e)).toMatch(/turned down the token refresh \(HTTP \d+\)/);
    }
    expect(String(await client(scripted([json(200, { access_token: "a".repeat(8193) })]).fetch).client.list("sales", 0).catch((x: unknown) => x))).toContain("turned down");
  });

  it("keeps the access token until five minutes before it runs out", async () => {
    let now = NOW.getTime();
    const { fetch, sent } = scripted([token({ expires_in: 3600 }), page([], null), page([], null), token(), page([], null)]);
    const { client: c } = client(fetch, { clock: () => now });
    await c.list("sales", 0);
    now += 55 * 60_000 - 1;
    await c.list("sales", 0);
    now += 1;
    await c.list("sales", 0);
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(["/api/1.0/token", "/api/2026-10/sales", "/api/2026-10/sales", "/api/1.0/token", "/api/2026-10/sales"]);
  });

  it("keeps a token ten minutes when expires_in can't be read", async () => {
    for (const expires_in of ["3600", 3600.5, -1, 0, 10_000_000, null]) {
      let now = NOW.getTime();
      const { fetch, sent } = scripted([token({ expires_in }), page([], null), page([], null), token(), page([], null)]);
      const { client: c } = client(fetch, { clock: () => now });
      await c.list("sales", 0);
      now += 5 * 60_000 - 1;
      await c.list("sales", 0);
      now += 1;
      await c.list("sales", 0);
      expect(sent.filter((s) => s.url.endsWith("/token")), String(expires_in)).toHaveLength(2);
    }
    let now = NOW.getTime();
    const { fetch, sent } = scripted([token({ expires_in: 9_999_999 }), page([], null), page([], null)]);
    const { client: c } = client(fetch, { clock: () => now });
    await c.list("sales", 0);
    now += 9_999_999_000 - 5 * 60_000 - 1;
    await c.list("sales", 0);
    expect(sent.filter((s) => s.url.endsWith("/token"))).toHaveLength(1);
  });

  it("runs one refresh at a time, so two reads never spend the same refresh token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const fetch = (async (url: string | URL) => {
      sent.push(String(url));
      if (String(url).endsWith("/token")) {
        await gate;
        return token()();
      }
      return page([], null)();
    }) as typeof globalThis.fetch;
    const { client: c } = client(fetch);
    const both = Promise.all([c.list("sales", 0), c.list("products", 0)]);
    release();
    await both;
    expect(sent.filter((u) => u.endsWith("/token"))).toHaveLength(1);
    // A failed refresh doesn't stick: the next read tries again.
    const again = scripted([json(500, {}), token(), page([], null)]);
    const second = client(again.fetch).client;
    await expect(second.list("sales", 0)).rejects.toThrow("HTTP 500");
    await expect(second.list("sales", 0)).resolves.toEqual({ data: [], max: null });
  });

  it("refreshes once on a 401, then gives up", async () => {
    const { fetch, sent } = scripted([token(), json(401, {}), token({ access_token: "testaccess00000000000002" }), page([], null)]);
    await client(fetch).client.list("customers", 0);
    expect(new Headers(sent[3]!.init?.headers).get("authorization")).toBe("Bearer testaccess00000000000002");
    const twice = scripted([token(), json(401, {}), token(), json(401, {})]);
    const error = await client(twice.fetch).client.list("customers", 0).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).toContain("turned down the customers read");
    expect(twice.sent).toHaveLength(4);
  });

  it("names the scopes on a 403, and the status on other errors", async () => {
    const forbidden = await client(scripted([token(), json(403, {})]).fetch).client.list("sales", 0).catch((e: unknown) => e);
    expect(forbidden).toMatchObject({ status: 403 });
    expect(String(forbidden)).toContain("check the connection has products:read inventory:read customers:read sales:read");
    const broken = await client(scripted([token(), json(500, {})]).fetch).client.list("sales", 0).catch((e: unknown) => e);
    expect(broken).toMatchObject({ name: "LightspeedApiError", status: 500, message: "Lightspeed sales answered HTTP 500" });
    const missing = await client(scripted([token(), json(404, {})]).fetch).client.list("sales", 0).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404 });
    const notJson = await client(scripted([token(), raw(200, "<html>")]).fetch).client.list("sales", 0).catch((e: unknown) => e);
    expect(notJson).toMatchObject({ status: 200, message: "Lightspeed sales did not answer with JSON" });
  });

  it("waits out 429s and brief outages, honoring Retry-After up to a minute, then leaves the error to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const date = new Date(NOW.getTime() + 30_000).toUTCString();
    const { fetch } = scripted([token(), json(429, {}, { "retry-after": "7" }), json(429, {}, { "retry-after": date }), json(503, {}), page([], null)]);
    await client(fetch, { sleep }).client.list("sales", 0);
    expect(waits).toEqual([7000, 30_000, 4000]);
    waits.length = 0;
    const more = scripted([token(), json(429, {}, { "retry-after": "600" }), json(502, {}, { "retry-after": "nonsense" }), json(504, {}, { "retry-after": "0" }), json(429, {})]);
    const error = await client(more.fetch, { sleep }).client.list("sales", 0).catch((e: unknown) => e);
    expect(waits).toEqual([60_000, 2000, 4000]);
    expect(error).toMatchObject({ status: 429 });
    expect(String(error)).toContain("kept rate-limiting the sales reads");
    const down = scripted([token(), json(503, {}), json(503, {})]);
    await expect(client(down.fetch, { sleep, retries: 1 }).client.list("sales", 0)).rejects.toMatchObject({ status: 503 });
    const busyRefresh = scripted([json(429, {}), token(), page([], null)]);
    await expect(client(busyRefresh.fetch, { sleep }).client.list("sales", 0)).resolves.toEqual({ data: [], max: null });
    const none = scripted([token(), json(500, {})]);
    await expect(client(none.fetch, { sleep }).client.list("sales", 0)).rejects.toMatchObject({ status: 500 });
    expect(none.sent).toHaveLength(2);
  });

  it("reads Retry-After in seconds or as a date", () => {
    const now = NOW.getTime();
    expect(lightspeedRetryAfter(null, now)).toBeNull();
    expect(lightspeedRetryAfter("12", now)).toBe(12);
    expect(lightspeedRetryAfter(" 12 ", now)).toBe(12);
    expect(lightspeedRetryAfter("1234567", now)).toBeNull();
    expect(lightspeedRetryAfter("soon", now)).toBeNull();
    expect(lightspeedRetryAfter(new Date(now + 1500).toUTCString(), now)).toBe(1);
    expect(lightspeedRetryAfter(new Date(now + 10_100).toISOString(), now)).toBe(11);
    expect(lightspeedRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });

  it("tells read scopes from the rest", () => {
    expect(lightspeedWriteScopes("sales:read products:read:costs  customers:read")).toEqual([]);
    expect(lightspeedWriteScopes("sales:write sales:read Sales:read products:read:costs:more read :read sales:readx")).toEqual(["sales:write", "Sales:read", "products:read:costs:more", "read", ":read", "sales:readx"]);
  });

  it("reads only its lists, from a version, and turns down a page that doesn't move forward", async () => {
    const c = client(scripted([]).fetch).client;
    await expect(c.list("orders" as never, 0)).rejects.toThrow("not a Lightspeed list");
    for (const after of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) await expect(c.list("sales", after), String(after)).rejects.toThrow("after must be a version number");
    for (const [data, max] of [
      [[{ id: "a" }], 5],
      [[{ id: "a" }], 4],
      [[{ id: "a" }], null],
      [[{ id: "a" }], -1],
    ] as const) {
      const { fetch } = scripted([token(), page([...data], max)]);
      await expect(client(fetch).client.list("sales", 5), String(max)).rejects.toThrow("without a newer version");
    }
    const noVersion = scripted([token(), json(200, { data: [{ id: "a" }] })]);
    await expect(client(noVersion.fetch).client.list("sales", 5)).rejects.toThrow("without a newer version");
    for (const body of [{}, { data: {} }, [], null]) {
      await expect(client(scripted([token(), json(200, body)]).fetch).client.list("sales", 0), JSON.stringify(body)).rejects.toThrow("without a data list");
    }
    await expect(client(scripted([token(), page([], 9)]).fetch).client.list("sales", 0)).resolves.toEqual({ data: [], max: null });
    await expect(client(scripted([token(), page([{ id: "a" }], 6)]).fetch).client.list("sales", 5)).resolves.toEqual({ data: [{ id: "a" }], max: 6 });
  });

  it("reads inventory with the search body Lightspeed documents", async () => {
    const { fetch, sent } = scripted([token(), json(200, [{ id: "a" }, "x", null, [2]])]);
    expect(await client(fetch).client.inventory(12)).toEqual([{ id: "a" }]);
    expect([sent[1]!.url, sent[1]!.init?.method]).toEqual([`${HOST}/api/2026-10/inventory`, "POST"]);
    expect(JSON.parse(String(sent[1]!.init?.body))).toEqual({ after: 12, size: LIGHTSPEED_INVENTORY_PAGE, sort_direction: "asc" });
    expect(new Headers(sent[1]!.init?.headers).get("content-type")).toBe("application/json");
    expect(LIGHTSPEED_INVENTORY_PAGE).toBe(1000);
    await expect(client(scripted([token(), json(200, { data: [] })]).fetch).client.inventory(0)).rejects.toThrow("inventory answered without a list");
    await expect(client(scripted([]).fetch).client.inventory(-1)).rejects.toThrow("after must be a version number");
  });

  it("reads one product, and answers null for one Lightspeed doesn't have", async () => {
    const { fetch, sent } = scripted([token(), json(200, { data: { id: pid(1), sku: "A" } }), json(404, {}), json(200, { data: [] }), json(200, {})]);
    const c = client(fetch).client;
    expect(await c.product(pid(1))).toEqual({ id: pid(1), sku: "A" });
    expect([sent[1]!.url, sent[1]!.init?.method]).toEqual([`${HOST}/api/2026-10/products/${pid(1)}`, "GET"]);
    expect(await c.product(pid(2))).toBeNull();
    expect(await c.product(pid(3))).toBeNull();
    expect(await c.product(pid(3))).toBeNull();
    for (const id of ["../sales", pid(1).toUpperCase(), "ABCDEF00-0000-4000-8000-000000000001", `${pid(1)}x`, "0000000-00000-4000-8000-000000000001", ""]) await expect(c.product(id), id).rejects.toThrow("not a Lightspeed product ID");
    await expect(client(scripted([token(), json(500, {})]).fetch).client.product(pid(1))).rejects.toMatchObject({ status: 500 });
  });
});

describe("Lightspeed records", () => {
  it("reads Lightspeed's ids, times, amounts and counts", () => {
    expect(lightspeedId(` ${pid(1).toUpperCase()} `)).toBe(pid(1));
    for (const bad of ["x", 5, null, `${pid(1)}0`, pid(1).replace(/-/g, ""), "0000000-00000-4000-8000-000000000001", "00000000-0000-4000-8000-00000000000-1"]) expect(lightspeedId(bad), String(bad)).toBeUndefined();
    expect(lightspeedTime("2026-01-05T15:00:00Z")).toBe("2026-01-05T15:00:00.000Z");
    expect(lightspeedTime("2026-01-05T15:00:00+00:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(lightspeedTime("2026-01-05 15:00:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(lightspeedTime(" 2026-01-05T15:00:00.123456Z ")).toBe("2026-01-05T15:00:00.123Z");
    expect(lightspeedTime("2026-01-05T15:00:00-0500")).toBe("2026-01-05T20:00:00.000Z");
    expect(lightspeedTime("2026-01-05T15:00:00+05:30")).toBe("2026-01-05T09:30:00.000Z");
    // Spaces are trimmed, but a value longer than any time Lightspeed writes is turned down first.
    expect(lightspeedTime(`${" ".repeat(20)}2026-01-05T15:00:00Z`)).toBe("2026-01-05T15:00:00.000Z");
    expect(lightspeedTime(`${" ".repeat(21)}2026-01-05T15:00:00Z`)).toBeUndefined();
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-05T25:00:00", "2026-01-05", "yesterday", 5, null, `2026-01-05T15:00:00${"0".repeat(30)}Z`, "2026-01-05T15:00:00+5:00"]) {
      expect(lightspeedTime(bad), String(bad)).toBeUndefined();
    }
    expect(lightspeedCents(1250.5)).toBe(125050);
    expect(lightspeedCents("1250.50")).toBe(125050);
    expect(lightspeedCents(" -0.29 ")).toBe(-29);
    expect(lightspeedCents(0.29)).toBe(29);
    expect(lightspeedCents(-0.001)).toBe(0);
    expect(Object.is(lightspeedCents(-0.001), -0)).toBe(false);
    expect(lightspeedCents(1e9)).toBe(1e11);
    for (const bad of [1e9 + 1, "1e3", "", "12,50", Number.NaN, Number.POSITIVE_INFINITY, null, "1.123456789", "12345678901"]) expect(lightspeedCents(bad), String(bad)).toBeNull();
    expect(lightspeedCents("999999999.12345678")).toBe(99999999912);
    expect(lightspeedCents("1234567890.12")).toBeNull();
    expect(lightspeedQuantity(2)).toBe(2);
    expect(lightspeedQuantity(-1)).toBe(-1);
    expect(lightspeedQuantity("2.0")).toBe(2);
    expect(lightspeedQuantity(" 3 ")).toBe(3);
    expect(Object.is(lightspeedQuantity(-0), -0)).toBe(false);
    for (const bad of [2.5, "2.5", "two", null, 1e9 + 1, "1234567890", Number.NaN]) expect(lightspeedQuantity(bad), String(bad)).toBeNull();
    expect(lightspeedQuantity(1e9)).toBe(1e9);
    expect(lightspeedVersion({ version: 5 })).toBe(5);
    expect(lightspeedVersion({ _metadata: { version: 6 } })).toBe(6);
    expect(lightspeedVersion({ version: 5, _metadata: { version: 6 } })).toBe(5);
    for (const bad of [{ version: -1 }, { version: 1.5 }, { version: "5" }, {}, { _metadata: null }]) expect(lightspeedVersion(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("reads the usual payment type names", () => {
    const cases: [string, string][] = [
      ["Cash", "cash"],
      ["Credit Card", "card"],
      ["Debit", "card"],
      ["EFTPOS", "card"],
      ["Visa", "card"],
      ["Mastercard", "card"],
      ["Amex", "card"],
      ["American Express", "card"],
      ["Discover", "card"],
      ["Tap to pay", "card"],
      ["Gift Card", "gift_card"],
      ["Store Credit", "other"],
      ["On Account", "other"],
      ["Loyalty", "other"],
      ["Voucher", "other"],
      ["Check", "check"],
      ["Cheque", "check"],
      ["Afterpay", "financing"],
      ["Affirm", "financing"],
      ["Klarna", "financing"],
      ["Layby", "financing"],
      ["Lay-by", "financing"],
      ["Layaway", "financing"],
      ["Financing", "financing"],
      ["Synchrony", "financing"],
      ["Zip", "financing"],
      ["Wire", "wire"],
      ["Bank transfer", "wire"],
      ["ACH", "wire"],
      ["Bitcoin", "other"],
    ];
    for (const [name, method] of cases) expect(lightspeedPaymentMethod(name), name).toBe(method);
    expect(lightspeedPaymentMethod(undefined)).toBe("other");
  });

  it("turns a closed sale into its state, the sale and how it was paid", () => {
    const events = lightspeedSaleEvents(SALE, ctx());
    const customer = lightspeedCustomerRef(KEY, lightspeedTestId("c", 1))!;
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    expect(events[0]).toEqual({
      id: `lightspeed_order:${SALE.id}:4001`,
      type: "order.updated",
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `lightspeed:order:${SALE.id}:4001`,
      payload: {
        orderId: `lightspeed:sale:${SALE.id}`,
        locationId: `lightspeed:outlet:${lightspeedTestId("0", 1)}`,
        registerId: `lightspeed:register:${lightspeedTestId("9", 1)}`,
        createdAt: "2026-01-01T01:00:00.000Z",
        state: "CLOSED",
        channel: "store",
        totalCents: 125060,
        lineCount: 1,
        linesComplete: true,
        customerId: customer,
      },
    });
    expect(events[1]).toEqual({
      id: `lightspeed_sale:${SALE.id}`,
      type: "sale.completed",
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `lightspeed:sale:${SALE.id}`,
      payload: {
        saleId: `lightspeed:sale:${SALE.id}`,
        customerId: customer,
        channel: "store",
        lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 125050, discountCents: 10000 }],
        totalCents: 125060,
        payments: [{ method: "card", amountCents: 125060 }],
      },
    });
    expect(customer.startsWith(LIGHTSPEED_CUSTOMER_PREFIX)).toBe(true);
  });

  it("keeps no customer, staff, note or cost details", () => {
    const text = JSON.stringify([lightspeedSaleEvents(SALE, ctx()), CUSTOMERS.map((c) => lightspeedCustomerEvent(c, ctx())), PRODUCTS.map((p) => lightspeedProductEvent(p, ctx()))]);
    for (const leak of ["Test Customer", "example.test", "555", "Test Street", "Testville", "rose gold", "1990-01-01", "Engraving", "Test Staff", "TEST-1", "R-TEST", lightspeedTestId("c", 1), lightspeedTestId("8", 1), "640", "SUP-"]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it("keeps the version, else the update time, in the state's key", () => {
    const noVersion = { ...SALE, _metadata: null, version: undefined };
    expect(lightspeedSaleEvents(noVersion, ctx())[0]!.idempotencyKey).toBe(`lightspeed:order:${SALE.id}:2026-01-01T01:00:00.000Z`);
    expect(lightspeedSaleEvents({ ...noVersion, updated_at: null }, ctx())[0]).toMatchObject({ idempotencyKey: `lightspeed:order:${SALE.id}:unknown`, occurredAt: undefined });
    expect(lightspeedSaleEvents({ ...SALE, version: 9 }, ctx())[0]!.idempotencyKey).toBe(`lightspeed:order:${SALE.id}:9`);
  });

  it("records a voided or deleted sale's state only", () => {
    const voided = lightspeedSaleEvents({ ...SALE, state: "voided" }, ctx());
    expect(voided.map((e) => e.type)).toEqual(["order.updated"]);
    expect(voided[0]!.payload).toMatchObject({ state: "VOIDED", cancelledAt: "2026-01-01T01:00:00.000Z" });
    const deleted = lightspeedSaleEvents({ ...SALE, deleted_at: "2026-03-01T00:00:00Z" }, ctx());
    expect(deleted.map((e) => e.type)).toEqual(["order.updated"]);
    expect(deleted[0]!.payload).toMatchObject({ state: "DELETED", cancelledAt: "2026-03-01T00:00:00.000Z" });
    const deletedVoid = lightspeedSaleEvents({ ...SALE, state: "voided", deleted_at: "2026-03-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" }, ctx());
    expect(deletedVoid[0]!.payload).toMatchObject({ state: "DELETED", cancelledAt: "2026-03-01T00:00:00.000Z" });
    for (const state of ["parked", "pending"]) {
      const open = lightspeedSaleEvents({ ...SALE, state }, ctx());
      expect(open.map((e) => e.type)).toEqual(["order.updated"]);
      expect(open[0]!.payload.state).toBe(state.toUpperCase());
      expect(open[0]!.payload).not.toHaveProperty("cancelledAt");
    }
    for (const state of ["CLOSED", "closed!", 5, "x".repeat(21)]) {
      const odd = lightspeedSaleEvents({ ...SALE, state }, ctx());
      expect(odd.map((e) => e.type), String(state)).toEqual(["order.updated"]);
      expect(odd[0]!.payload).not.toHaveProperty("state");
    }
  });

  it("turns lines taken back into a return against the original sale, and an exchange into both", () => {
    const original = lightspeedTestId("d", 99);
    const returned = { ...SALE, return: { is_return: true, original_sale_id: original }, totals: { price_incl_tax: -1250.6 }, line_items: [{ ...(SALE.line_items as LightspeedRecord[])[0]!, quantity: -1, pricing: { price: 1150.5, total: -1150.5 } }] };
    const events = lightspeedSaleEvents(returned, ctx());
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.returned"]);
    expect(events[1]).toMatchObject({
      idempotencyKey: `lightspeed:return:${SALE.id}`,
      occurredAt: "2026-01-01T01:00:00.000Z",
      payload: { saleId: `lightspeed:sale:${original}`, returnId: `lightspeed:return:${SALE.id}`, lines: [{ sku: "SKU-TEST-0001", quantity: 1, refundCents: 115050 }] },
    });
    // Unlinked, it is recorded against itself; an unreadable refund stays null so the schema dead-letters it.
    const unlinked = lightspeedSaleEvents({ ...returned, return: null, line_items: [{ product: { sku: "A" }, quantity: "-2", pricing: { total: "x" } }] }, ctx());
    expect(unlinked[1]!.payload).toEqual({ saleId: `lightspeed:sale:${SALE.id}`, returnId: `lightspeed:return:${SALE.id}`, lines: [{ sku: "A", quantity: 2, refundCents: null }] });
    const exchange = lightspeedSaleEvents({ ...SALE, totals: { price_incl_tax: 100 }, line_items: [{ product: { sku: "NEW" }, quantity: 1, pricing: { price: 1350.5 } }, { product: { sku: "OLD" }, quantity: -1, pricing: { total: -1250.5 } }] }, ctx());
    expect(exchange.map((e) => e.type)).toEqual(["order.updated", "sale.completed", "sale.returned"]);
    expect(exchange[1]!.payload.lines).toEqual([{ sku: "NEW", quantity: 1, unitPriceCents: 135050, discountCents: 0 }]);
    expect(exchange[2]!.payload.lines).toEqual([{ sku: "OLD", quantity: 1, refundCents: 125050 }]);
  });

  it("gives no sale for a closed sale with nothing sold or nothing to pay", () => {
    for (const totals of [{ price_incl_tax: 0 }, { price_incl_tax: "x" }, {}, null]) {
      expect(lightspeedSaleEvents({ ...SALE, totals }, ctx()).map((e) => e.type), JSON.stringify(totals)).toEqual(["order.updated"]);
    }
    expect(lightspeedSaleEvents({ ...SALE, line_items: [] }, ctx()).map((e) => e.type)).toEqual(["order.updated"]);
    expect(lightspeedSaleEvents({ ...SALE, line_items: "x" }, ctx())[0]!.payload.lineCount).toBe(0);
    expect(lightspeedSaleEvents({ ...SALE, line_items: ["x", null, [1], ...(SALE.line_items as unknown[])] }, ctx())[0]!.payload.lineCount).toBe(1);
    // A line with no quantity is neither sold nor taken back.
    const zero = lightspeedSaleEvents({ ...SALE, line_items: [...(SALE.line_items as unknown[]), { product: { sku: "Z" }, quantity: 0, pricing: { price: 1, total: 0 } }] }, ctx());
    expect(zero.map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    expect((zero[1]!.payload.lines as { sku: string }[]).map((l) => l.sku)).toEqual(["SKU-TEST-0001"]);
    expect(lightspeedSaleEvents({ ...SALE, totals: { price_incl_tax: 0.01 } }, ctx()).map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
  });

  it("reads each line's SKU from the line, then the product, then a stand-in", () => {
    const line = (product: unknown, id?: string) => ({ id, product, quantity: 1, pricing: { price: 10 } });
    const sale = { ...SALE, line_items: [line({ id: pid(5), sku: "  OWN  " }), line({ id: pid(6), sku: " " }), line({ id: pid(7) }), line(null, lightspeedTestId("1", 9)), line(null), line({ sku: 5 })] };
    const known: LightspeedContext = ctx({ sku: (id) => (id === pid(6) ? "KNOWN" : `lightspeed-product-${id}`) });
    const lines = lightspeedSaleEvents(sale, known)[1]!.payload.lines as { sku: string }[];
    expect(lines.map((l) => l.sku)).toEqual(["OWN", "KNOWN", `lightspeed-product-${pid(7)}`, `lightspeed-line-${SALE.id}-${lightspeedTestId("1", 9)}`, `lightspeed-line-${SALE.id}-4`, `lightspeed-line-${SALE.id}-5`]);
    expect((lightspeedSaleEvents({ ...SALE, line_items: [line({ sku: "x".repeat(150) })] }, ctx())[1]!.payload.lines as { sku: string }[])[0]!.sku).toHaveLength(100);
  });

  it("works out each line's price before discount and the discount", () => {
    const lines = (pricing: unknown, quantity: unknown = 2) => lightspeedSaleEvents({ ...SALE, line_items: [{ product: { sku: "A" }, quantity, pricing }] }, ctx())[1]!.payload.lines;
    expect(lines({ price: 90, discount: 10, discount_total: 20 })).toEqual([{ sku: "A", quantity: 2, unitPriceCents: 10000, discountCents: 2000 }]);
    expect(lines({ price: 90, discount: 10 })).toEqual([{ sku: "A", quantity: 2, unitPriceCents: 10000, discountCents: 2000 }]);
    expect(lines({ price: 90 })).toEqual([{ sku: "A", quantity: 2, unitPriceCents: 9000, discountCents: 0 }]);
    // An unreadable quantity or price is kept as null, so the sales schema dead-letters the sale.
    expect(lines({ price: "x", discount: 10 })).toEqual([{ sku: "A", quantity: 2, unitPriceCents: null, discountCents: 2000 }]);
    expect(lines({ price: 90, discount: 10 }, 1.5)).toEqual([{ sku: "A", quantity: null, unitPriceCents: 10000, discountCents: 0 }]);
    expect(lines(null)).toEqual([{ sku: "A", quantity: 2, unitPriceCents: null, discountCents: 0 }]);
  });

  it("lists each payment by method, leaves out deleted and empty ones, and falls back to other", () => {
    const paid = (payments: unknown) => lightspeedSaleEvents({ ...SALE, payments }, ctx())[1]!.payload.payments;
    expect(paid([{ amount: 1000, type: { name: "Cash" } }, { amount: "250.60", type: { name: "Gift Card" } }, { amount: 5, type: null }])).toEqual([
      { method: "cash", amountCents: 100000 },
      { method: "gift_card", amountCents: 25060 },
      { method: "other", amountCents: 500 },
    ]);
    expect(paid([{ amount: 1000, type: { name: "Cash" }, deleted_at: "2026-01-02T00:00:00Z" }, { amount: 0 }, { amount: -5 }, { amount: "x" }, "nope"])).toEqual([{ method: "other", amountCents: 125060 }]);
    expect(paid([{ amount: 10, deleted_at: "not a time" }])).toEqual([{ method: "other", amountCents: 1000 }]);
    expect(paid(undefined)).toEqual([{ method: "other", amountCents: 125060 }]);
  });

  it("calls a sale from the web store online", () => {
    for (const [type, channel] of [["ECOM", "online"], ["web", "online"], ["Online", "online"], ["USER", "store"], [undefined, "store"]] as const) {
      expect(lightspeedSaleEvents({ ...SALE, source: { type } }, ctx())[1]!.payload.channel, String(type)).toBe(channel);
    }
    expect(lightspeedSaleEvents({ ...SALE, source: null }, ctx())[0]!.payload).not.toHaveProperty("locationId");
  });

  it("leaves out what a sale doesn't have", () => {
    const bare = lightspeedSaleEvents({ id: SALE.id, state: "closed", date: "2026-01-01T00:00:00Z", line_items: [{ product: { sku: "A" }, quantity: 1, pricing: { price: 1 } }], totals: { price_incl_tax: 1 } }, ctx());
    expect(bare[0]!.payload).toEqual({ orderId: `lightspeed:sale:${SALE.id}`, state: "CLOSED", channel: "store", totalCents: 100, lineCount: 1, linesComplete: true });
    expect(bare[1]!.payload).not.toHaveProperty("customerId");
    expect(lightspeedSaleEvents({ ...SALE, customer_id: "walk-in" }, ctx())[1]!.payload).not.toHaveProperty("customerId");
    expect(lightspeedSaleEvents({ ...SALE, date: "x" }, ctx())[1]!.occurredAt).toBeUndefined();
    for (const id of [undefined, "x", 5]) expect(lightspeedSaleEvents({ ...SALE, id }, ctx()), String(id)).toEqual([]);
    expect(lightspeedSaleEvents(null as never, ctx())).toEqual([]);
  });

  it("turns a product into product.updated with its one variant", () => {
    const product = PRODUCTS[0]!;
    expect(lightspeedProductEvent(product, ctx())).toEqual({
      id: `lightspeed_product:${product.id}:1001:ACTIVE`,
      type: "product.updated",
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `lightspeed:product:${product.id}:1001:ACTIVE`,
      payload: {
        productId: `lightspeed:product:${product.id}`,
        title: "Test 14k ring 1",
        status: "ACTIVE",
        vendor: null,
        productType: null,
        tags: [],
        variants: [{ variantId: `lightspeed:product:${product.id}`, sku: "SKU-TEST-0001", priceCents: 125050, inventoryQuantity: null }],
      },
    });
    const status = (over: LightspeedRecord) => lightspeedProductEvent({ ...product, ...over }, ctx())!.payload.status;
    expect(status({ active: { in_store: false, ecwid: false } })).toBe("ARCHIVED");
    expect(status({ active: { in_store: false } })).toBe("ARCHIVED");
    expect(status({ active: { in_store: false, ecwid: true } })).toBe("ACTIVE");
    expect(status({ active: { in_store: true, ecwid: false } })).toBe("ACTIVE");
    expect(status({ active: null })).toBe("ACTIVE");
    expect(status({ deleted_at: "2026-02-01T00:00:00Z" })).toBe("DELETED");
    expect(status({ deleted_at: "x" })).toBe("ACTIVE");
    expect(lightspeedProductEvent({ ...product, variant_name: "  Test 14k\n  ring\t 1 " }, ctx())!.payload.title).toBe("Test 14k ring 1");
    const bare = lightspeedProductEvent({ id: product.id }, ctx())!;
    expect(bare).toMatchObject({ idempotencyKey: `lightspeed:product:${product.id}:unknown:ACTIVE`, occurredAt: undefined });
    expect(bare.payload).toMatchObject({ title: `Lightspeed product ${String(product.id).slice(0, 8)}`, variants: [{ sku: `lightspeed-product-${product.id}`, priceCents: null }] });
    expect(lightspeedProductEvent({ ...product, version: undefined }, ctx())!.idempotencyKey).toBe(`lightspeed:product:${product.id}:2026-01-01T01:00:00.000Z:ACTIVE`);
    expect(lightspeedProductEvent({ ...product, id: "x" }, ctx())).toBeNull();
    expect(lightspeedProductEvent(null as never, ctx())).toBeNull();
  });

  it("turns an inventory record into a count for its outlet, dated when read", () => {
    const item = INVENTORY[0]!;
    expect(lightspeedInventoryEvent(item, ctx({ sku: () => "SKU-TEST-0001" }))).toEqual({
      id: `lightspeed_count:${pid(1)}:${lightspeedTestId("0", 1)}:2001`,
      type: "inventory.counted",
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: `lightspeed:count:${pid(1)}:${lightspeedTestId("0", 1)}:2001`,
      payload: { sku: "SKU-TEST-0001", onHand: 3, variantId: `lightspeed:product:${pid(1)}`, locationId: `lightspeed:outlet:${lightspeedTestId("0", 1)}` },
    });
    expect(lightspeedInventoryEvent({ ...item, current_inventory_level: 1.5 }, ctx())!.payload.onHand).toBeNull();
    expect(lightspeedInventoryEvent({ ...item, current_inventory_level: -2 }, ctx())!.payload.onHand).toBe(-2);
    expect(lightspeedInventoryEvent({ ...item, version: undefined }, ctx())!.idempotencyKey).toBe(`lightspeed:count:${pid(1)}:${lightspeedTestId("0", 1)}:${RECEIVED}`);
    expect(lightspeedInventoryEvent({ ...item, deleted_at: "2026-01-01T00:00:00Z" }, ctx())).toBeNull();
    expect(lightspeedInventoryEvent({ ...item, deleted_at: "x" }, ctx())).not.toBeNull();
    expect(lightspeedInventoryEvent({ ...item, product_id: "x" }, ctx())).toBeNull();
    expect(lightspeedInventoryEvent({ ...item, outlet_id: null }, ctx())).toBeNull();
    expect(lightspeedInventoryEvent(null as never, ctx())).toBeNull();
  });

  it("turns a customer into a profile under a keyed reference, with no consent assumed", () => {
    const customer = CUSTOMERS[0]!;
    const ref = lightspeedCustomerRef(KEY, customer.id)!;
    const mac = ref.slice(LIGHTSPEED_CUSTOMER_PREFIX.length);
    expect(mac).toMatch(/^[0-9a-f]{32}$/);
    expect(lightspeedCustomerEvent(customer, ctx())).toEqual({
      id: `lightspeed_customer:${mac}:3001`,
      type: "customer.profile_updated",
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `lightspeed:customer:${mac}:3001`,
      payload: { customerId: ref, name: `Lightspeed customer ${mac.slice(0, 8)}`, marketingConsent: false },
    });
    expect(lightspeedCustomerEvent({ ...customer, do_not_email: false, enable_promotional_sms: true }, ctx())!.payload.marketingConsent).toBe(false);
    expect(lightspeedCustomerEvent({ ...customer, version: undefined }, ctx())!.idempotencyKey).toBe(`lightspeed:customer:${mac}:2026-01-01T01:00:00.000Z`);
    expect(lightspeedCustomerEvent({ id: customer.id }, ctx())!.idempotencyKey).toBe(`lightspeed:customer:${mac}:unknown`);
    expect(lightspeedCustomerEvent({ ...customer, deleted_at: "2026-02-01T00:00:00Z" }, ctx())).toBeNull();
    expect(lightspeedCustomerEvent({ ...customer, id: "x" }, ctx())).toBeNull();
    expect(lightspeedCustomerEvent(null as never, ctx())).toBeNull();
  });

  it("keys customer references by the instance's key and the id, case and spaces aside", () => {
    const id = lightspeedTestId("c", 1);
    expect(lightspeedCustomerRef(KEY, id)).toBe(lightspeedCustomerRef(KEY, ` ${id.toUpperCase()} `));
    expect(lightspeedCustomerRef(KEY, id)).not.toBe(lightspeedCustomerRef(["test", "4".repeat(60)].join(""), id));
    expect(lightspeedCustomerRef(KEY, id)).not.toBe(lightspeedCustomerRef(KEY, lightspeedTestId("c", 2)));
    // Not the same reference Square would give the same id.
    expect(lightspeedCustomerRef(KEY, id)).toMatch(/^lightspeed:customer:[0-9a-f]{32}$/);
    expect(lightspeedCustomerRef(KEY, id)!.split(":")[2]).not.toBe(squareCustomerRef(KEY, id)!.split(":")[2]);
    for (const bad of [undefined, 5, "", "walk-in"]) expect(lightspeedCustomerRef(KEY, bad), String(bad)).toBeUndefined();
    expect(() => lightspeedCustomerRef("short", id)).toThrow("CUSTOMER_REF_KEY");
  });
});

describe("the Lightspeed connector", () => {
  it("imports products, stock, customers and sales, in that order, from version 0", async () => {
    const mock = store();
    const out = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.reads).toEqual([
      { list: "products", after: 0 },
      { list: "products", after: 1003 },
      { list: "inventory", after: 0 },
      { list: "customers", after: 0 },
      { list: "customers", after: 3002 },
      { list: "sales", after: 0 },
      { list: "sales", after: 4002 },
    ]);
    expect(out.map((b) => b.events.length)).toEqual([3, 0, 3, 2, 0, 4, 0]);
    expect(out.map((b) => cursorOf(b).step)).toEqual([0, 1, 2, 2, 3, 3, 4]);
    expect(cursorOf(out.at(-1)!)).toEqual({ pass: "historical", step: 4, after: { products: 1003, inventory: 2003, customers: 3002, sales: 4002 } });
    const counted = eventsOf(out).filter((e) => e.type === "inventory.counted");
    // The products just read give the counts their SKUs, with no lookups.
    expect(counted.map((e) => e.payload.sku)).toEqual(["SKU-TEST-0001", "SKU-TEST-0002", "SKU-TEST-0003"]);
    expect(mock.reads.some((r) => r.list.startsWith("product:"))).toBe(false);
    expect(LIGHTSPEED_STREAMS).toEqual(["products", "inventory", "customers", "sales"]);
  });

  it("pages each list until an empty page, and inventory until a short one", async () => {
    const products = Array.from({ length: 5 }, (_, i) => ({ ...PRODUCTS[0]!, id: pid(10 + i), version: 10 + i }));
    const inventory = Array.from({ length: LIGHTSPEED_INVENTORY_PAGE + 1 }, (_, i) => ({ ...INVENTORY[0]!, id: lightspeedTestId("b", 100 + i), product_id: pid(10 + (i % 5)), version: 100 + i }));
    const mock = store({ products, inventory, customers: [], sales: [], pageSize: 2 });
    const out = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.reads.map((r) => `${r.list}:${r.after}`)).toEqual(["products:0", "products:11", "products:13", "products:14", "inventory:0", "inventory:1099", "customers:0", "sales:0"]);
    expect(eventsOf(out).filter((e) => e.type === "inventory.counted")).toHaveLength(LIGHTSPEED_INVENTORY_PAGE + 1);
    expect(cursorOf(out.at(-1)!).after).toEqual({ products: 14, inventory: 1100, customers: 0, sales: 0 });
  });

  it("stops on an inventory page that doesn't move forward", async () => {
    for (const inventory of [[{ ...INVENTORY[0]!, version: 0 }], [{ ...INVENTORY[0]!, version: undefined }]]) {
      const mock = store({ inventory: [], products: [], customers: [], sales: [] });
      // The mock only answers records above the version asked, so a stand-in client answers these.
      const fake: LightspeedClient = { list: async () => ({ data: [], max: null }), inventory: async () => inventory, product: async () => null };
      await expect(collect(connector(mock, { client: fake }).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("without a newer version");
    }
  });

  it("asks Lightspeed for the SKUs of products it hasn't read this run, once each, and keeps a stand-in for ones it no longer has", async () => {
    const gone = pid(77);
    const inventory = [
      ...INVENTORY,
      { ...INVENTORY[0]!, id: lightspeedTestId("b", 9), outlet_id: lightspeedTestId("0", 2), version: 2009 },
      { ...INVENTORY[0]!, id: lightspeedTestId("b", 10), product_id: gone, version: 2010 },
      { ...INVENTORY[0]!, id: lightspeedTestId("b", 11), product_id: gone, outlet_id: lightspeedTestId("0", 2), version: 2011 },
    ];
    const mock = store({ inventory });
    const resumed: LightspeedCursor = { pass: "historical", step: 1, after: { products: 1003, inventory: 0, customers: 0, sales: 0 } };
    const out = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) }));
    expect(mock.reads.filter((r) => r.list.startsWith("product:")).map((r) => r.list)).toEqual([`product:${pid(1)}`, `product:${pid(2)}`, `product:${pid(3)}`, `product:${gone}`]);
    const counted = eventsOf(out).filter((e) => e.type === "inventory.counted");
    expect(counted.map((e) => e.payload.sku)).toEqual(["SKU-TEST-0001", "SKU-TEST-0002", "SKU-TEST-0003", "SKU-TEST-0001", `lightspeed-product-${gone}`, `lightspeed-product-${gone}`]);
    // A product with no SKU of its own keeps the stand-in too, and sales find the SKUs the lookups learned.
    const blank = store({ products: [{ ...PRODUCTS[0]!, sku: " " }], inventory: [INVENTORY[0]!], sales: [{ ...SALE, line_items: [{ product: { id: pid(1) }, quantity: 1, pricing: { price: 1 } }] }] });
    const blankOut = await collect(connector(blank).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) }));
    expect(eventsOf(blankOut).filter((e) => e.type === "inventory.counted").map((e) => e.payload.sku)).toEqual([`lightspeed-product-${pid(1)}`]);
    const looked = store({ products: [{ ...PRODUCTS[0]!, sku: "  LOOKED-UP  " }], inventory: [INVENTORY[0]!], sales: [{ ...SALE, line_items: [{ product: { id: pid(1) }, quantity: 1, pricing: { price: 1 } }] }] });
    const lookedOut = await collect(connector(looked).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) }));
    expect(eventsOf(lookedOut).filter((e) => e.type === "sale.completed").map((e) => (e.payload.lines as { sku: string }[])[0]!.sku)).toEqual(["LOOKED-UP"]);
    expect(eventsOf(lookedOut).filter((e) => e.type === "inventory.counted").map((e) => e.payload.sku)).toEqual(["LOOKED-UP"]);
  });

  it("remembers a product Lightspeed no longer has, so later pages don't ask again", async () => {
    const gone = pid(78);
    const record = (v: number) => ({ ...INVENTORY[0]!, id: lightspeedTestId("b", v), product_id: gone, version: v });
    const pages = [Array.from({ length: LIGHTSPEED_INVENTORY_PAGE }, (_, i) => record(i + 1)), [record(LIGHTSPEED_INVENTORY_PAGE + 1)]];
    const asked: string[] = [];
    const fake: LightspeedClient = {
      list: async () => ({ data: [], max: null }),
      inventory: async () => pages.shift() ?? [],
      product: async (id) => {
        asked.push(id);
        return null;
      },
    };
    const out = await collect(connector(store(), { client: fake }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(asked).toEqual([gone]);
    expect(eventsOf(out).filter((e) => e.type === "inventory.counted")).toHaveLength(LIGHTSPEED_INVENTORY_PAGE + 1);
  });

  it("skips sales older than the history window, keeping an undated one so it dead-letters", async () => {
    const old = { ...SALE, id: lightspeedTestId("d", 50), version: 4050, _metadata: { version: 4050 }, date: "2021-11-10T11:59:59Z" };
    const edge = { ...SALE, id: lightspeedTestId("d", 51), version: 4051, _metadata: { version: 4051 }, date: "2021-11-10T12:00:00Z" };
    const undated = { ...SALE, id: lightspeedTestId("d", 52), version: 4052, _metadata: { version: 4052 }, date: null };
    const mock = store({ sales: [old, edge, undated] });
    const out = await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const sales = eventsOf(out).filter((e) => e.type === "sale.completed");
    expect(sales.map((e) => e.payload.saleId)).toEqual([`lightspeed:sale:${edge.id}`, `lightspeed:sale:${undated.id}`]);
    expect(sales[1]!.occurredAt).toBeUndefined();
    expect(cursorOf(out.at(-1)!).after.sales).toBe(4052);
    const shorter = store({ sales: [edge] });
    const two = await collect(connector(shorter, { historyYears: 2 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(eventsOf(two).filter((e) => e.type === "sale.completed")).toEqual([]);
  });

  it("leaves a finished import finished, and resumes an interrupted one", async () => {
    const done: LightspeedCursor = { pass: "historical", step: 4, after: { products: 1003, inventory: 2003, customers: 3002, sales: 4002 } };
    const mock = store();
    expect([await collect(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })), mock.fetch.calls]).toEqual([[], []]);
    const midway: LightspeedCursor = { pass: "historical", step: 3, after: { products: 1003, inventory: 2003, customers: 3002, sales: 4001 } };
    const resumed = store();
    const out = await collect(connector(resumed).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(midway) }));
    expect(resumed.reads).toEqual([
      { list: "sales", after: 4001 },
      { list: "sales", after: 4002 },
    ]);
    expect(eventsOf(out).map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    // An incremental checkpoint doesn't stand in for the import's own.
    const other = store();
    await collect(connector(other).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, pass: "incremental" }) }));
    expect(other.reads[0]).toEqual({ list: "products", after: 0 });
  });

  it("reads only what changed since the last incremental pass, pass after pass", async () => {
    const data = { products: [...PRODUCTS], inventory: [...INVENTORY], customers: [...CUSTOMERS], sales: [...SALES] };
    const first = store(data);
    const firstOut = await collect(connector(first).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const finished = cursorOf(firstOut.at(-1)!);
    expect(finished).toEqual({ pass: "incremental", step: 4, after: { products: 1003, inventory: 2003, customers: 3002, sales: 4002 } });
    // Nothing new: one empty read of each list.
    const quiet = store(data);
    const quietOut = await collect(connector(quiet).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(finished) }));
    expect(quiet.reads.map((r) => `${r.list}:${r.after}`)).toEqual(["products:1003", "inventory:2003", "customers:3002", "sales:4002"]);
    expect(eventsOf(quietOut)).toEqual([]);
    expect(cursorOf(quietOut.at(-1)!)).toEqual(finished);
    // A sale closed and a stock level changed since: only those come back, and the stock's product is looked up.
    const changed = store({ ...data, inventory: [...data.inventory, { ...INVENTORY[1]!, current_inventory_level: 2, version: 2004 }], sales: [...data.sales, { ...SALES[1]!, state: "voided", version: 4003, _metadata: { version: 4003 } }] });
    const changedOut = await collect(connector(changed).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(finished) }));
    expect(eventsOf(changedOut).map((e) => [e.type, e.payload.sku ?? e.payload.state])).toEqual([
      ["inventory.counted", "SKU-TEST-0002"],
      ["order.updated", "VOIDED"],
    ]);
    expect(changed.reads.filter((r) => r.list.startsWith("product:"))).toEqual([{ list: `product:${pid(2)}`, after: 0 }]);
    expect(cursorOf(changedOut.at(-1)!).after).toEqual({ products: 1003, inventory: 2004, customers: 3002, sales: 4003 });
    // An interrupted incremental pass resumes where it stopped.
    const midway = { ...finished, step: 2 };
    const resumed = store(data);
    await collect(connector(resumed).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(midway) }));
    expect(resumed.reads.map((r) => r.list)).toEqual(["customers", "sales"]);
    // A historical checkpoint isn't an incremental one: the first incremental pass reads from the start.
    const after = store(data);
    await collect(connector(after).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...finished, pass: "historical" }) }));
    expect(after.reads[0]).toEqual({ list: "products", after: 0 });
  });

  it("refreshes the token once a run and hands each new refresh token to the store", async () => {
    const mock = store();
    const tokens = memoryTokenStore(SEED);
    await collect(connector(mock, { tokens }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.accessTokens).toHaveLength(1);
    expect(tokens.current).toBe(mock.refreshToken);
    expect(tokens.current).not.toBe(SEED);
    // The next run uses the stored token, which the mock now takes; the seed no longer works.
    await collect(connector(mock, { tokens }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.accessTokens).toHaveLength(2);
    await expect(collect(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("invalid_grant");
  });

  it("refreshes again when Lightspeed revokes the access token mid-run", async () => {
    const mock = store();
    const c = connector(mock);
    const pages = c.historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]();
    await pages.next();
    mock.revokeTokens();
    for (let r = await pages.next(); !r.done; r = await pages.next());
    expect(mock.accessTokens).toHaveLength(2);
  });

  it("waits out Lightspeed's rate limit and stops when it lasts", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await collect(connector(store({ rateLimits: ["3", null] }), { sleep }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(waits).toEqual([3000, 2000]);
    await expect(collect(connector(store({ rateLimits: ["1", "1", "1", "1"] }), { sleep }).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ status: 429 });
  });

  it("passes every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(store()), expected: { ingested: 12 } });
    expect(result.full.batches).toBe(7);
    const undated = { ...SALE, id: lightspeedTestId("d", 60), version: 4060, _metadata: { version: 4060 }, date: null };
    const dead = await checkConnectorSync({ makeConnector: () => connector(store({ sales: [...SALES, undated] })), expected: { ingested: 13, deadLettered: 1 } });
    expect(dead.full.deadLettered).toBe(1);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const returned = { ...SALE, id: lightspeedTestId("d", 70), version: 4070, _metadata: { version: 4070 }, return: { is_return: true, original_sale_id: SALE.id }, totals: { price_incl_tax: -1250.6 }, line_items: [{ product: { id: pid(1), sku: "SKU-TEST-0001" }, quantity: -1, pricing: { price: 1150.5, total: -1150.5 } }] };
    const negative = { ...INVENTORY[0]!, id: lightspeedTestId("b", 80), outlet_id: lightspeedTestId("0", 2), current_inventory_level: -1, version: 2080 };
    const report = await runSync({ connector: connector(store({ sales: [...SALES, returned], inventory: [...INVENTORY, negative] })), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Negative stock is dead-lettered by the inventory schema, as Square's is.
    expect(report).toMatchObject({ ingested: 14, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(new Set(["product.updated", "inventory.counted", "customer.profile_updated", "order.updated", "sale.completed", "sale.returned"]));
    expect(memory.events.filter((e) => e.type === "sale.completed")).toHaveLength(2);
  });

  it("checks the checkpoint it resumes from", () => {
    const good: LightspeedCursor = { pass: "incremental", step: 2, after: { products: 1, inventory: 2, customers: 3, sales: 4 } };
    expect(parseLightspeedCursor(JSON.stringify({ ...good, extra: 1, after: { ...good.after, orders: 9 } }))).toEqual(good);
    expect(parseLightspeedCursor(JSON.stringify({ ...good, step: 4 }))).toEqual({ ...good, step: 4 });
    expect(parseLightspeedCursor(JSON.stringify({ ...good, step: 0, after: { products: 0, inventory: 0, customers: 0, sales: 0 } }))).not.toBeNull();
    expect(parseLightspeedCursor(null)).toBeNull();
    const bad = [
      "not json",
      "null",
      "5",
      JSON.stringify({ ...good, pass: "other" }),
      JSON.stringify({ ...good, step: 5 }),
      JSON.stringify({ ...good, step: -1 }),
      JSON.stringify({ ...good, step: 1.5 }),
      JSON.stringify({ ...good, step: "1" }),
      JSON.stringify({ ...good, after: null }),
      JSON.stringify({ ...good, after: "x" }),
      JSON.stringify({ ...good, after: { ...good.after, sales: -1 } }),
      JSON.stringify({ ...good, after: { ...good.after, inventory: 1.5 } }),
      JSON.stringify({ ...good, after: { products: 1, inventory: 2, customers: 3 } }),
      JSON.stringify({ ...good, after: { ...good.after, products: "1" } }),
    ];
    for (const raw of bad) expect(() => parseLightspeedCursor(raw), raw).toThrow("Lightspeed checkpoint is not in the expected shape");
  });

  it("checks its options, declares its one write behind the gate, and takes no webhooks", async () => {
    expect(() => connector(store(), { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(store(), { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(store(), { historyYears: 1 })).not.toThrow();
    assertSynthetic({ PRODUCTS, INVENTORY, CUSTOMERS, SALES });
    expect(LIGHTSPEED_WRITES).toEqual([{ integration: "lightspeed", name: "adjust_inventory", description: "Adjust a product's stock level at an outlet" }]);
    expect(await assertWritesRefused(connector())).toMatchObject([{ action: "adjust_inventory", integration: "lightspeed", outcome: "refused" }]);
    expect(connector().source).toBe("lightspeed");
    expect(connector().handleWebhook).toBeUndefined();
  });
});
