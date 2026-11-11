import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, squarespaceDocMock, squarespaceOrder, squarespaceProduct, squarespaceStock, testPipeline, type SquarespaceMock, type SquarespaceMockData, type SquarespaceMockRecord } from "@karatos/connector-testkit";
import {
  SQUARESPACE_BASE_URL,
  SQUARESPACE_EVENTS,
  SQUARESPACE_LISTS,
  SQUARESPACE_OVERLAP_MS,
  SQUARESPACE_STEPS,
  SQUARESPACE_USER_AGENT,
  SQUARESPACE_WRITES,
  SquarespaceApiError,
  SquarespaceConfigError,
  parseSquarespaceCursor,
  squarespaceCents,
  squarespaceClient,
  squarespaceConnector,
  squarespaceCustomerRef,
  squarespaceListParams,
  squarespaceOrderEvent,
  squarespaceProductEvent,
  squarespaceStockEvent,
  squarespaceTime,
  type SquarespaceClient,
  type SquarespaceClientOptions,
  type SquarespaceEvent,
  type SquarespaceOptions,
} from "../src/index.js";

// A credential-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY_VALUE = ["sq", "a".repeat(30)].join("");
const CUSTOMER_KEY = "k".repeat(64);
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const CTX = { receivedAt: RECEIVED, customerKey: CUSTOMER_KEY };
const DAY_MS = 86_400_000;
const ORDERS = `${SQUARESPACE_BASE_URL}/1.0/commerce/orders`;
const noSleep = async () => {};
const W = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-11T15:00:00.000Z" };
const money = (value: unknown, currency = "USD") => ({ currency, value });

function account(overrides: Partial<SquarespaceMockData> = {}): SquarespaceMockData {
  squarespaceProduct.reset();
  squarespaceStock.reset();
  squarespaceOrder.reset();
  return { apiKey: KEY_VALUE, products: squarespaceProduct.many(2), inventory: squarespaceStock.many(3), orders: squarespaceOrder.many(2), ...overrides };
}
const base = (fetch?: typeof globalThis.fetch): SquarespaceClientOptions => ({ apiKey: KEY_VALUE, sleep: noSleep, ...(fetch ? { fetch } : {}) });
const connector = (mock: SquarespaceMock, overrides: Partial<SquarespaceOptions> = {}) => squarespaceConnector({ ...base(mock.fetch), customerKey: CUSTOMER_KEY, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as SquarespaceEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}
/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const page = (field: string, n: number, next: unknown = null) => json(200, { [field]: Array.from({ length: n }, () => ({})), pagination: { hasNextPage: next !== null, nextPageCursor: next, nextPageUrl: null } });
const client = (fetch: typeof globalThis.fetch, extra: Partial<SquarespaceClientOptions> = {}) => {
  const slept: number[] = [];
  return { c: squarespaceClient({ ...base(fetch), sleep: async (ms) => void slept.push(ms), ...extra }), slept };
};

describe("Squarespace queries", () => {
  it("sends a cursor alone, a window for the first page of orders, and nothing else", () => {
    expect(Object.fromEntries(squarespaceListParams("orders", { cursor: null, ...W }))).toEqual({ modifiedAfter: W.from, modifiedBefore: W.to });
    expect(Object.fromEntries(squarespaceListParams("orders", { cursor: "abc_DEF-1=+/.:", ...W }))).toEqual({ cursor: "abc_DEF-1=+/.:" });
    for (const list of ["products", "inventory"] as const) {
      expect([...squarespaceListParams(list, { cursor: null, ...W })]).toEqual([]);
      expect([...squarespaceListParams(list, { cursor: null })]).toEqual([]);
      expect(Object.fromEntries(squarespaceListParams(list, { cursor: "c1" }))).toEqual({ cursor: "c1" });
    }
    expect(Object.fromEntries(squarespaceListParams("orders", { cursor: null, from: W.to, to: W.to }))).toEqual({ modifiedAfter: W.to, modifiedBefore: W.to });
    expect(Object.keys(SQUARESPACE_LISTS)).toEqual(["products", "inventory", "orders"]);
    expect(SQUARESPACE_STEPS).toEqual(["products", "inventory", "orders"]);
    for (const list of ["", "profiles", "toString"]) expect(() => squarespaceListParams(list as never, { cursor: null }), list).toThrow(new SquarespaceConfigError("Squarespace reads only products, inventory and orders"));
    for (const cursor of ["", "a b", "a&b=1", "a?b", `${"a".repeat(2049)}`, "a\n"]) expect(() => squarespaceListParams("orders", { cursor, ...W }), cursor).toThrow(new SquarespaceConfigError("a page cursor must be one Squarespace gave"));
    expect(Object.fromEntries(squarespaceListParams("orders", { cursor: "a".repeat(2048) })).cursor).toHaveLength(2048);
    for (const q of [{}, { from: W.from }, { to: W.to }, { from: "2026-11-01", to: W.to }, { from: W.from, to: "soon" }, { from: W.to, to: W.from }, { from: `1${W.from}`, to: W.to }, { from: W.from, to: `${W.to}x` }, { from: "2026-11-01T00:00:00Z", to: W.to }]) expect(() => squarespaceListParams("orders", { cursor: null, ...q }), JSON.stringify(q)).toThrow(new SquarespaceConfigError("orders are listed between two UTC times"));
  });
});

describe("Squarespace client", () => {
  it("checks its key before sending anything", () => {
    const { fetch, sent } = scripted(page("result", 0));
    for (const apiKey of ["", "x".repeat(15), "x".repeat(513), `${"x".repeat(10)} ${"x".repeat(10)}`, `${"x".repeat(10)}\n${"x".repeat(10)}`, `${"x".repeat(16)}\x7f`, undefined as never]) expect(() => squarespaceClient({ ...base(fetch), apiKey }), String(apiKey)).toThrow(new SquarespaceConfigError("SQUARESPACE_API_KEY is missing or not in the expected shape"));
    expect(() => squarespaceClient({ ...base(fetch), apiKey: "!".repeat(16) })).not.toThrow();
    expect(() => squarespaceClient({ ...base(fetch), apiKey: "~".repeat(512) })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("sends only GETs, with the key, trimmed, as a Bearer token and a User-Agent, never in the URL", async () => {
    const { fetch, sent } = scripted(page("result", 2, "next1"));
    const { c } = client(fetch, { apiKey: ` ${KEY_VALUE}\n` });
    expect(await c.list("orders", { cursor: null, ...W })).toEqual({ records: [{}, {}], next: "next1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ORDERS}?modifiedAfter=${encodeURIComponent(W.from)}&modifiedBefore=${encodeURIComponent(W.to)}`);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.headers).toEqual({ authorization: `Bearer ${KEY_VALUE}`, "user-agent": SQUARESPACE_USER_AGENT, accept: "application/json" });
    expect(sent[0]!.body).toBeUndefined();
    expect(sent[0]!.url).not.toContain(KEY_VALUE);
    const items = scripted(page("inventory", 1), page("products", 1));
    const r = client(items.fetch).c;
    expect((await r.list("inventory", { cursor: null })).records).toHaveLength(1);
    expect((await r.list("products", { cursor: null })).next).toBeNull();
    expect(items.sent.map((s) => s.url)).toEqual([`${SQUARESPACE_BASE_URL}/1.0/commerce/inventory`, `${SQUARESPACE_BASE_URL}/v2/commerce/products`]);
    expect(SQUARESPACE_BASE_URL).toBe("https://api.squarespace.com");
  });

  it("reads each list from its own field, and stops only where Squarespace says no page follows", async () => {
    for (const [list, field] of [["products", "products"], ["inventory", "inventory"], ["orders", "result"]] as const) {
      const x = (await client(scripted(page("result", 1), page("products", 1), page("inventory", 1)).fetch).c.list(list, { cursor: "c" }).catch((e: Error) => e)) as Error | { records: unknown[] };
      if (field === "result") expect(x).toEqual({ records: [{}], next: null });
      else expect(x, list).toBeInstanceOf(SquarespaceApiError);
    }
    expect(await client(scripted(json(200, { result: [], pagination: { hasNextPage: false, nextPageCursor: "ignored" } })).fetch).c.list("orders", { cursor: "c" })).toEqual({ records: [], next: null });
    expect(await client(scripted(json(200, { result: [] })).fetch).c.list("orders", { cursor: "c" })).toEqual({ records: [], next: null });
    expect(await client(scripted(json(200, { result: [], pagination: { hasNextPage: "true", nextPageCursor: "c2" } })).fetch).c.list("orders", { cursor: "c" })).toEqual({ records: [], next: null });
    for (const next of [undefined, null, "", "a b", 5]) {
      const e = (await client(scripted(json(200, { result: [], pagination: { hasNextPage: true, nextPageCursor: next } })).fetch).c.list("orders", { cursor: "c" }).catch((x: Error) => x)) as SquarespaceApiError;
      expect([e.message, e.status, e.name], String(next)).toEqual(["Squarespace said more orders follow without a cursor that reads", 200, "SquarespaceApiError"]);
    }
  });

  it("says what is wrong with the key or the site, never repeating Squarespace's words", async () => {
    const cases: [number, string][] = [
      [401, "Squarespace turned down SQUARESPACE_API_KEY (HTTP 401); make a new key under Settings, Developer API Keys"],
      [402, "Squarespace says the site's plan has expired (HTTP 402)"],
      [403, "SQUARESPACE_API_KEY lacks Read Only permission for Orders (HTTP 403)"],
    ];
    for (const [status, message] of cases) {
      const s = scripted(json(status, { message: "secret detail" }));
      const e = (await client(s.fetch).c.list("orders", { cursor: "c" }).catch((x: Error) => x)) as Error;
      expect(e, String(status)).toEqual(new SquarespaceConfigError(message));
      expect(e.name).toBe("SquarespaceConfigError");
      expect(s.sent).toHaveLength(1);
    }
    await expect(client(scripted(json(403, {})).fetch).c.list("inventory", { cursor: null })).rejects.toThrow("lacks Read Only permission for Inventory (HTTP 403)");
    await expect(client(scripted(json(403, {})).fetch).c.list("products", { cursor: null })).rejects.toThrow("lacks Read Only permission for Products (HTTP 403)");
    for (const status of [201, 400, 404, 405]) {
      const e = (await client(scripted(json(status, { message: "secret detail" })).fetch).c.list("orders", { cursor: "c" }).catch((x: Error) => x)) as SquarespaceApiError;
      expect([e.message, e.status], String(status)).toEqual([`Squarespace answered HTTP ${status} for orders`, status]);
    }
    for (const answer of [() => new Response("not json"), json(200, null), json(200, {}), json(200, { result: {} }), json(200, [])]) {
      const e = (await client(scripted(answer).fetch).c.list("orders", { cursor: "c" }).catch((x: Error) => x)) as SquarespaceApiError;
      expect([e.message, e.status]).toEqual(["Squarespace answered without a list of orders", 200]);
    }
  });

  it("checks a query before sending anything", async () => {
    const { fetch, sent } = scripted(page("result", 0));
    await expect(client(fetch).c.list("orders", { cursor: null })).rejects.toThrow(SquarespaceConfigError);
    expect(sent).toHaveLength(0);
  });

  it("waits out a rate limit for a minute, or as long as Retry-After says up to a minute, and server errors longer each time", async () => {
    const { fetch, sent } = scripted(json(429, {}), json(429, {}, { "retry-after": "5" }), json(429, {}, { "retry-after": "600" }), page("result", 0));
    const { c, slept } = client(fetch);
    expect(await c.list("orders", { cursor: "c" })).toEqual({ records: [], next: null });
    expect(slept).toEqual([60_000, 5000, 60_000]);
    expect(sent).toHaveLength(4);
    const odd = client(scripted(json(429, {}, { "retry-after": "soon" }), json(429, {}, { "retry-after": "0" }), page("result", 0)).fetch);
    await odd.c.list("orders", { cursor: "c" });
    expect(odd.slept).toEqual([60_000, 60_000]);
    const busy = client(scripted(json(500, {}), json(502, {}), json(503, {}), page("result", 0)).fetch);
    await busy.c.list("orders", { cursor: "c" });
    expect(busy.slept).toEqual([1000, 2000, 4000]);
    const always = scripted(json(503, {}, { "retry-after": "1" }));
    const a = client(always.fetch);
    await expect(a.c.list("orders", { cursor: "c" })).rejects.toThrow("Squarespace answered HTTP 503 for orders");
    expect(always.sent).toHaveLength(4);
    expect(a.slept).toEqual([1000, 2000, 4000]);
    const limited = scripted(json(429, {}));
    const e = (await client(limited.fetch).c.list("inventory", { cursor: null }).catch((x: Error) => x)) as SquarespaceApiError;
    expect([e.message, e.status]).toEqual(["Squarespace kept rate-limiting the sync (HTTP 429) on inventory; the next sync resumes from the checkpoint", 429]);
    expect(limited.sent).toHaveLength(4);
    const once = scripted(json(500, {}));
    await client(once.fetch, { retries: 0 }).c.list("orders", { cursor: "c" }).catch(() => undefined);
    expect(once.sent).toHaveLength(1);
    const one = scripted(json(500, {}));
    await client(one.fetch, { retries: 1 }).c.list("orders", { cursor: "c" }).catch(() => undefined);
    expect(one.sent).toHaveLength(2);
    for (const status of [400, 401, 404, 499]) {
      const s = scripted(json(status, {}));
      await client(s.fetch).c.list("orders", { cursor: "c" }).catch(() => undefined);
      expect(s.sent, String(status)).toHaveLength(1);
    }
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const s = scripted(json(500, {}), page("result", 0));
    globalThis.fetch = s.fetch;
    try {
      const started = Date.now();
      await squarespaceClient({ apiKey: KEY_VALUE }).list("orders", { cursor: "c" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    } finally {
      globalThis.fetch = real;
    }
    expect(s.sent).toHaveLength(2);
  });
});

describe("Squarespace reading helpers", () => {
  it("reads Squarespace's times as UTC, only with a zone", () => {
    expect(squarespaceTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(squarespaceTime("2026-01-02T03:04:05.123456789Z")).toBe("2026-01-02T03:04:05.123Z");
    expect(squarespaceTime("2026-01-02T03:04:05.5-05:00")).toBe("2026-01-02T08:04:05.500Z");
    expect(squarespaceTime("2026-01-02T03:04:05.9999Z")).toBe("2026-01-02T03:04:05.999Z");
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-02T24:00:00Z", "2026-01-02T12:60:00Z", "2026-01-02T03:04:05", "2026-01-02", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05.1234567890Z", "2026-01-02T03:04:05+0200", "2026-01-02T03:04:05z", "x2026-01-02T03:04:05Z", "2026-01-02T03:04:05Zx", "", null, 5]) expect(squarespaceTime(bad), String(bad)).toBeUndefined();
  });

  it("reads money in whole cents from a number or a decimal string, half a cent away from zero", () => {
    expect(squarespaceCents(money(49.99))).toBe(4999);
    expect(squarespaceCents(money("49.99"))).toBe(4999);
    expect(squarespaceCents(money("12"))).toBe(1200);
    expect(squarespaceCents(money(0.005))).toBe(1);
    expect(squarespaceCents(money(-0.005))).toBe(-1);
    expect(squarespaceCents(money("-12.345"))).toBe(-1235);
    expect(squarespaceCents(money(0.125))).toBe(13);
    expect(squarespaceCents(money(0))).toBe(0);
    expect(squarespaceCents(money("999999999999.99"))).toBe(99_999_999_999_999);
    expect(squarespaceCents(money("1.123456"))).toBe(112);
    for (const bad of [money(1e12), money(-1e12), money(Number.NaN), money(Number.POSITIVE_INFINITY), money("1e3"), money("1,5"), money(" 1"), money("1."), money(".5"), money("1.1234567"), money("9999999999999"), money(null), money(true), null, "12", 12, {}]) expect(squarespaceCents(bad), JSON.stringify(bad)).toBeNull();
  });

  it("makes keyed customer references, different by key and by customer", () => {
    const a = squarespaceCustomerRef(CUSTOMER_KEY, "e00000000000000000000001");
    expect(a).toMatch(/^squarespace_customer:[0-9a-f]{32}$/);
    expect(squarespaceCustomerRef(CUSTOMER_KEY, "e00000000000000000000001")).toBe(a);
    expect(squarespaceCustomerRef("j".repeat(64), "e00000000000000000000001")).not.toBe(a);
    expect(squarespaceCustomerRef(CUSTOMER_KEY, "e00000000000000000000002")).not.toBe(a);
    expect(a).toBe(`squarespace_customer:${createHmac("sha256", CUSTOMER_KEY).update("squarespace_customer:e00000000000000000000001").digest("hex").slice(0, 32)}`);
  });
});

describe("Squarespace events", () => {
  const product = (o: SquarespaceMockRecord = {}) => {
    squarespaceProduct.reset();
    return squarespaceProduct.one(o);
  };
  const stock = (o: SquarespaceMockRecord = {}) => {
    squarespaceStock.reset();
    return squarespaceStock.one(o);
  };
  const order = (o: SquarespaceMockRecord = {}) => {
    squarespaceOrder.reset();
    return squarespaceOrder.one(o);
  };

  it("names its event types", () => {
    expect(SQUARESPACE_EVENTS).toEqual({ product: "product.updated", stock: "inventory.counted", order: "order.updated" });
  });

  it("turns a product into product.updated with each variant's price, sale price and stock", () => {
    const e = squarespaceProductEvent(product(), CTX);
    expect(e.type).toBe("product.updated");
    expect(e.occurredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({
      system: "Squarespace",
      productId: "squarespace:product:a00000000000000000000001",
      type: "physical",
      name: "Test 14K solitaire setting",
      visible: true,
      storePageId: "squarespace:store_page:b00000000000000000000001",
      currency: "USD",
      variants: [
        { variantId: "squarespace:variant:c00000000000000000000001", sku: "SQ-RING-1-6", priceCents: 125050, salePriceCents: 0, onSale: false, stock: 3, unlimited: false },
        { variantId: "squarespace:variant:c00000000000000000000002", sku: "SQ-RING-1-7", priceCents: 125050, salePriceCents: 99999, onSale: true, stock: 0, unlimited: true },
      ],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(/^squarespace:product:a00000000000000000000001:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(JSON.stringify(e)).not.toContain("Test description");
    expect(squarespaceProductEvent(product(), { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(e.idempotencyKey);
    expect(squarespaceProductEvent(product({ isVisible: false }), CTX).idempotencyKey).not.toBe(e.idempotencyKey);
  });

  it("keeps what reads of a product and its variants", () => {
    const odd = squarespaceProductEvent(product({ type: "BUNDLE", name: ` ${"N".repeat(210)} `, isVisible: "yes", storePageId: "bad id", createdOn: "soon", variants: [{ id: "x y", sku: 5, pricing: { basePrice: money(1, "usd"), salePrice: money("x"), onSale: 1 }, stock: { quantity: -1, unlimited: null } }, null, "x"] }), CTX).payload;
    expect(odd).toMatchObject({ type: "other", name: "N".repeat(200), visible: null, storePageId: null, currency: null, createdAt: null });
    expect(odd.variants).toStrictEqual([
      { variantId: null, sku: null, priceCents: 100, salePriceCents: null, onSale: null, stock: null, unlimited: null },
      { variantId: null, sku: null, priceCents: null, salePriceCents: null, onSale: null, stock: null, unlimited: null },
      { variantId: null, sku: null, priceCents: null, salePriceCents: null, onSale: null, stock: null, unlimited: null },
    ]);
    expect((squarespaceProductEvent(product({ name: "   ", variants: [{ id: "" }] }), CTX).payload as { name: unknown; variants: { variantId: unknown }[] })).toMatchObject({ name: null, variants: [{ variantId: null }] });
    const bare = squarespaceProductEvent(product({ type: null, variants: undefined }), CTX).payload;
    expect([bare.type, bare.variants, bare.currency]).toEqual([null, [], null]);
    expect((squarespaceProductEvent(product({ variants: [{ sku: ` ${"S".repeat(70)} `, stock: { quantity: 1.5 } }] }), CTX).payload.variants as Record<string, unknown>[])[0]).toMatchObject({ sku: "S".repeat(60), stock: null });
    for (const type of ["PHYSICAL", "SERVICE", "GIFT_CARD", "DIGITAL"]) expect(squarespaceProductEvent(product({ type }), CTX).payload.type).toBe(type.toLowerCase());
  });

  it("dead-letters a product that doesn't read, listing why", () => {
    const e = squarespaceProductEvent(product({ id: "", modifiedOn: "2026-10-02T00:00:00" }), CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.payload).toStrictEqual({ system: "Squarespace", problems: ["product has no ID that reads", "product has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^squarespace:unreadable_product:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(squarespaceProductEvent(product({ id: "", modifiedOn: "x" }), CTX).idempotencyKey).not.toBe(e.idempotencyKey);
    const t = squarespaceProductEvent(product({ modifiedOn: null }), CTX);
    expect([t.payload.problems, t.occurredAt]).toEqual([["product has no time that reads"], undefined]);
    expect(t.idempotencyKey).toMatch(/^squarespace:unreadable_product:/);
    for (const id of [5, "a b", "a:b", "x".repeat(65)]) expect(squarespaceProductEvent(product({ id }), CTX).payload.problems, String(id)).toEqual(["product has no ID that reads"]);
    expect(squarespaceProductEvent(product({ id: "A_b-".repeat(16) }), CTX).payload.problems).toBeUndefined();
    for (const raw of [null, "x", []]) expect(squarespaceProductEvent(raw, CTX).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });

  it("turns a stock line into inventory.counted, with no count when stock isn't tracked", () => {
    const e = squarespaceStockEvent(stock(), CTX);
    expect(e.type).toBe("inventory.counted");
    expect(e.occurredAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({ system: "Squarespace", sku: "SQ-RING-1", onHand: 1, unlimited: false, variantId: "squarespace:variant:c00000000000000000000001", locationId: "squarespace:store" });
    expect(e.idempotencyKey).toMatch(/^squarespace:stock:c00000000000000000000001:[0-9a-f]{12}$/);
    // A count is keyed by what it says, not when it was read.
    expect(squarespaceStockEvent(stock(), { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(e.idempotencyKey);
    expect(squarespaceStockEvent(stock({ quantity: 2 }), CTX).idempotencyKey).not.toBe(e.idempotencyKey);
    expect(squarespaceStockEvent(stock({ isUnlimited: true, quantity: 4 }), CTX).payload).toMatchObject({ onHand: null, unlimited: true });
    expect(squarespaceStockEvent(stock({ isUnlimited: "no", quantity: 4 }), CTX).payload).toMatchObject({ onHand: null, unlimited: null });
    expect(squarespaceStockEvent(stock({ quantity: 0 }), CTX).payload.onHand).toBe(0);
    expect(squarespaceStockEvent(stock({ quantity: -1 }), CTX).payload.onHand).toBeNull();
    const dead = squarespaceStockEvent(stock({ variantId: "" }), CTX);
    expect([dead.occurredAt, dead.payload]).toEqual([undefined, { system: "Squarespace", problems: ["stock line has no variant ID that reads"] }]);
    expect(dead.idempotencyKey).toMatch(/^squarespace:unreadable_stock:[0-9a-f]{12}$/);
  });

  it("turns an order into order.updated, with money in cents, its lines and the customer under a keyed reference", () => {
    const e = squarespaceOrderEvent(order(), CTX);
    expect(e.type).toBe("order.updated");
    expect(e.occurredAt).toBe("2026-10-02T00:00:00.000Z");
    expect(e.payload).toStrictEqual({
      system: "Squarespace",
      orderId: "squarespace:order:d00000000000000000000001",
      orderNumber: "1001",
      channel: "web",
      channelName: null,
      fulfillment: "pending",
      payment: "paid",
      testMode: false,
      currency: "USD",
      subtotalCents: 125050,
      discountCents: 0,
      shippingCents: 0,
      taxCents: 11050,
      totalCents: 136100,
      refundedCents: 0,
      lines: [{ lineId: "squarespace:line:f00000000000000000000001", productId: "squarespace:product:a00000000000000000000001", variantId: "squarespace:variant:c00000000000000000000001", sku: "SQ-RING-1-6", name: "Test 14K solitaire setting", type: "physical_product", quantity: 1, unitPriceCents: 125050 }],
      customerId: squarespaceCustomerRef(CUSTOMER_KEY, "e00000000000000000000001"),
      createdAt: "2026-10-01T00:00:00.000Z",
      fulfilledAt: null,
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(/^squarespace:order:d00000000000000000000001:[0-9a-f]{12}$/);
    const all = JSON.stringify(e);
    for (const hidden of ["buyer@example.test", "Buyer", "1 Test St", "Testville", "Test engraving", "Test internal note", "Ring size", "e00000000000000000000001"]) expect(all, hidden).not.toContain(hidden);
    expect(squarespaceOrderEvent(order(), { ...CTX, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(e.idempotencyKey);
    expect(squarespaceOrderEvent(order({ fulfillmentStatus: "FULFILLED" }), CTX).idempotencyKey).not.toBe(e.idempotencyKey);
    // A change only to what is never kept is the same event.
    expect(squarespaceOrderEvent(order({ customerEmail: "other@example.test" }), CTX).idempotencyKey).toBe(e.idempotencyKey);
  });

  it("keeps what reads of an order and its lines", () => {
    const odd = squarespaceOrderEvent(order({ orderNumber: 1001, channel: ` ${"C".repeat(50)} `, channelName: "Test market", fulfillmentStatus: "LOST", paymentState: 5, testmode: "no", grandTotal: money("10", "usd"), customerId: "bad id", fulfilledOn: "2026-10-03T00:00:00Z", createdOn: null, lineItems: [{ quantity: -1, lineItemType: "BUNDLE", productName: ` ${"P".repeat(210)} ` }, null] }), CTX).payload;
    expect(odd).toMatchObject({ orderNumber: null, channel: "C".repeat(40), channelName: "Test market", fulfillment: "other", payment: null, testMode: null, currency: null, totalCents: 1000, customerId: null, fulfilledAt: "2026-10-03T00:00:00.000Z", createdAt: null });
    expect(odd.lines).toStrictEqual([
      { lineId: null, productId: null, variantId: null, sku: null, name: "P".repeat(200), type: "other", quantity: null, unitPriceCents: null },
      { lineId: null, productId: null, variantId: null, sku: null, name: null, type: null, quantity: null, unitPriceCents: null },
    ]);
    expect(squarespaceOrderEvent(order({ lineItems: "x" }), CTX).payload.lines).toEqual([]);
    expect(squarespaceOrderEvent(order({ channelName: ` ${"M".repeat(70)} ` }), CTX).payload.channelName).toBe("M".repeat(60));
    expect(squarespaceOrderEvent(order({ orderNumber: ` ${"9".repeat(50)} ` }), CTX).payload.orderNumber).toBe("9".repeat(40));
    for (const s of ["PENDING", "FULFILLED", "CANCELED"]) expect(squarespaceOrderEvent(order({ fulfillmentStatus: s }), CTX).payload.fulfillment).toBe(s.toLowerCase());
    for (const s of ["NOT_CHARGED", "AUTHORIZED", "PAID", "REFUNDED", "PENDING", "FAILED", "REFUND_PENDING", "REFUND_FAILED", "PARTIALLY_PAID"]) expect(squarespaceOrderEvent(order({ paymentState: s }), CTX).payload.payment).toBe(s.toLowerCase());
    for (const t of ["PHYSICAL_PRODUCT", "SERVICE_PRODUCT", "GIFT_CARD", "DIGITAL_PRODUCT", "PAYWALL_PRODUCT"]) expect((squarespaceOrderEvent(order({ lineItems: [{ lineItemType: t }] }), CTX).payload.lines as Record<string, unknown>[])[0]!.type).toBe(t.toLowerCase());
    expect(squarespaceOrderEvent(order({ testmode: true }), CTX).payload.testMode).toBe(true);
    expect(squarespaceOrderEvent(order({ refundedTotal: money(-5) }), CTX).payload.refundedCents).toBe(-500);
  });

  it("dead-letters an order that doesn't read, listing why", () => {
    const e = squarespaceOrderEvent(order({ id: null, modifiedOn: "soon" }), CTX);
    expect(e.occurredAt).toBeUndefined();
    expect(e.payload).toStrictEqual({ system: "Squarespace", problems: ["order has no ID that reads", "order has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^squarespace:unreadable_order:[0-9a-f]{12}$/);
    expect(squarespaceOrderEvent(order({ id: "a:b" }), CTX).payload.problems).toEqual(["order has no ID that reads"]);
    expect(squarespaceOrderEvent(order({ modifiedOn: 5 }), CTX).payload.problems).toEqual(["order has no time that reads"]);
    for (const raw of [null, "x", []]) expect(squarespaceOrderEvent(raw, CTX).payload.problems, JSON.stringify(raw)).toHaveLength(2);
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(account());
  });
});

describe("Squarespace checkpoint", () => {
  const F = "2021-11-11T15:00:00.000Z";
  const T = "2026-11-11T15:00:00.000Z";
  const N = "2026-11-10T15:00:00.000Z";
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseSquarespaceCursor(null)).toBeNull();
    for (const step of SQUARESPACE_STEPS)
      for (const cursor of [null, "c1"]) {
        const pass = { from: F, to: T, step, cursor };
        expect(parseSquarespaceCursor(JSON.stringify({ pass, done: true, nextFrom: N }))).toEqual({ pass, done: true, nextFrom: N });
      }
    expect(parseSquarespaceCursor(JSON.stringify({ pass: null, done: false, nextFrom: N }))).toEqual({ pass: null, done: false, nextFrom: N });
    expect(parseSquarespaceCursor(JSON.stringify({ pass: { from: T, to: T, step: "orders", cursor: null }, done: false, nextFrom: N }))!.pass).toEqual({ from: T, to: T, step: "orders", cursor: null });
    const pass = { from: F, to: T, step: "orders", cursor: null };
    const bad = ["", "x", "null", "[]", ...[{ pass: null, nextFrom: N }, { pass: null, done: "true", nextFrom: N }, { pass: null, done: false }, { pass: null, done: false, nextFrom: "2026-11-10" }, { done: false, nextFrom: N }, { pass: {}, done: false, nextFrom: N }, { pass: { ...pass, from: "2021-11-11" }, done: false, nextFrom: N }, { pass: { ...pass, to: "soon" }, done: false, nextFrom: N }, { pass: { ...pass, from: T, to: F }, done: false, nextFrom: N }, { pass: { ...pass, step: "profiles" }, done: false, nextFrom: N }, { pass: { ...pass, cursor: 5 }, done: false, nextFrom: N }, { pass: { from: F, to: T, step: "orders" }, done: false, nextFrom: N }].map((o) => JSON.stringify(o))];
    for (const raw of bad) expect(() => parseSquarespaceCursor(raw), raw).toThrow("Squarespace checkpoint is not in the expected shape");
  });
});

describe("Squarespace connector", () => {
  it("passes the shared connector checks", async () => {
    // Two products, three stock lines and two orders.
    const result = await checkConnectorSync({ makeConnector: () => connector(squarespaceDocMock(account())), expected: { ingested: 7 } });
    expect(result.full.ingested).toBe(7);
  });

  it("reads the catalog, the stock and five years of orders, and stops for good", async () => {
    const mock = squarespaceDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    expect(mock.reads).toEqual([
      { path: "/v2/commerce/products", query: {} },
      { path: "/1.0/commerce/inventory", query: {} },
      { path: "/1.0/commerce/orders", query: { modifiedAfter: "2021-11-11T15:00:00.000Z", modifiedBefore: "2026-11-11T15:00:00.000Z" } },
    ]);
    expect(parseSquarespaceCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" });
    expect(SQUARESPACE_OVERLAP_MS).toBe(DAY_MS);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(3);
    const deep = squarespaceDocMock(account());
    await drain(connector(deep, { historyYears: 7 }).historicalImport({ cursor: null } as never));
    expect(deep.reads[2]!.query.modifiedAfter).toBe("2019-11-11T15:00:00.000Z");
    expect(() => connector(deep, { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(deep, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least");
  });

  it("makes each page one batch, keeping the step and the next page's cursor, and resumes there", async () => {
    const asked: string[] = [];
    const pages: Record<string, (string | null)[]> = { products: ["p2", null], inventory: [null], orders: ["o2", null] };
    const fake: SquarespaceClient = {
      list: async (list, q) => {
        asked.push(`${list}:${q.cursor}:${q.from}:${q.to}`);
        const n = asked.filter((a) => a.startsWith(`${list}:`)).length - 1;
        return { records: [list === "orders" ? squarespaceOrder.one() : list === "products" ? squarespaceProduct.one() : squarespaceStock.one()], next: pages[list]![n] ?? null };
      },
    };
    squarespaceOrder.reset();
    const make = () => squarespaceConnector({ ...base(), customerKey: CUSTOMER_KEY, client: fake, now: NOW });
    const all = await drain(make().historicalImport({ cursor: null } as never));
    const F = "2021-11-11T15:00:00.000Z";
    const T = "2026-11-11T15:00:00.000Z";
    const N = "2026-11-10T15:00:00.000Z";
    expect(asked).toEqual([`products:null:${F}:${T}`, `products:p2:${F}:${T}`, `inventory:null:${F}:${T}`, `orders:null:${F}:${T}`, `orders:o2:${F}:${T}`]);
    expect(all.map((b) => parseSquarespaceCursor(b.cursor ?? null))).toEqual([
      { pass: { from: F, to: T, step: "products", cursor: "p2" }, done: false, nextFrom: N },
      { pass: { from: F, to: T, step: "inventory", cursor: null }, done: false, nextFrom: N },
      { pass: { from: F, to: T, step: "orders", cursor: null }, done: false, nextFrom: N },
      { pass: { from: F, to: T, step: "orders", cursor: "o2" }, done: false, nextFrom: N },
      { pass: null, done: true, nextFrom: N },
    ]);
    expect(all.map((b) => (b.events[0] as SquarespaceEvent).type)).toEqual(["product.updated", "product.updated", "inventory.counted", "order.updated", "order.updated"]);
    expect(eventsOf(all).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    asked.length = 0;
    pages.orders = [null];
    const mid = { pass: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", step: "orders", cursor: "o9" }, done: false, nextFrom: "2026-01-31T00:00:00.000Z" };
    const rest = await drain(make().historicalImport({ cursor: JSON.stringify(mid) } as never));
    expect(asked).toEqual(["orders:o9:2026-01-01T00:00:00.000Z:2026-02-01T00:00:00.000Z"]);
    expect(rest.map((b) => parseSquarespaceCursor(b.cursor ?? null))).toEqual([{ pass: null, done: true, nextFrom: "2026-01-31T00:00:00.000Z" }]);
    // Events are dated when they are read, not when the pass began.
    expect((rest[0]!.events[0] as SquarespaceEvent).receivedAt).toBe(RECEIVED);
    asked.length = 0;
    expect(await drain(make().historicalImport({ cursor: JSON.stringify({ ...mid, done: true }) } as never))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("reads the catalog and stock again and the orders changed from a day before the last pass ended on each later sync", async () => {
    const data = account();
    const mock = squarespaceDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync starts a day back.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.slice(3)).toEqual([
      { path: "/v2/commerce/products", query: {} },
      { path: "/1.0/commerce/inventory", query: {} },
      { path: "/1.0/commerce/orders", query: { modifiedAfter: "2026-11-10T15:00:00.000Z", modifiedBefore: "2026-11-11T15:00:00.000Z" } },
    ]);
    expect([first.ingested, first.duplicates]).toEqual([0, 5]);
    data.inventory![0]!.quantity = 9;
    data.orders!.push(squarespaceOrder.one({ modifiedOn: "2026-11-12T10:00:00Z" }));
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)!.query).toEqual({ modifiedAfter: "2026-11-10T15:00:00.000Z", modifiedBefore: "2026-11-12T15:00:00.000Z" });
    expect(sync.ingested).toBe(2);
    expect(parseSquarespaceCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-11T15:00:00.000Z" });
    // A later sync resumed mid-pass keeps its times and what it knew of the import.
    let calls = 0;
    const fake: SquarespaceClient = { list: async () => ({ records: [], next: calls++ === 0 ? "o4" : null }) };
    const mid = JSON.stringify({ pass: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", step: "orders", cursor: "o3" }, done: true, nextFrom: "2026-11-09T00:00:00.000Z" });
    const rest = await drain(squarespaceConnector({ ...base(), customerKey: CUSTOMER_KEY, client: fake, now: NOW }).incrementalSync({ cursor: mid } as never));
    expect(rest.map((b) => parseSquarespaceCursor(b.cursor ?? null))).toEqual([
      { pass: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z", step: "orders", cursor: "o4" }, done: true, nextFrom: "2026-11-09T00:00:00.000Z" },
      { pass: null, done: true, nextFrom: "2026-11-09T00:00:00.000Z" },
    ]);
    calls = 1;
    const midImport = mid.replace('"done":true', '"done":false');
    expect(parseSquarespaceCursor((await drain(squarespaceConnector({ ...base(), customerKey: CUSTOMER_KEY, client: fake, now: NOW }).incrementalSync({ cursor: midImport } as never))).at(-1)!.cursor ?? null)!.done).toBe(false);
    const after = squarespaceDocMock(account());
    const out = await drain(connector(after).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-01T00:00:00.000Z" }) } as never));
    expect(after.reads[2]!.query.modifiedAfter).toBe("2026-10-01T00:00:00.000Z");
    expect(parseSquarespaceCursor(out.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" });
  });

  it("pages through the mock with its cursors", async () => {
    squarespaceProduct.reset();
    squarespaceOrder.reset();
    const products = Array.from({ length: 101 }, () => squarespaceProduct.one({ modifiedOn: "2026-10-02T00:00:00Z" }));
    const orders = Array.from({ length: 51 }, () => squarespaceOrder.one({ modifiedOn: "2026-10-02T00:00:00Z" }));
    const mock = squarespaceDocMock(account({ products, orders, inventory: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([50, 50, 1, 0, 50, 1]);
    expect(new Set(eventsOf(batches).map((e) => e.payload.productId ?? e.payload.orderId)).size).toBe(152);
    expect(mock.reads.filter((r) => r.query.cursor).map((r) => Object.keys(r.query))).toEqual([["cursor"], ["cursor"], ["cursor"]]);
  });

  it("dead-letters a record that doesn't read and keeps going", async () => {
    const data = account();
    data.products![0]!.modifiedOn = "2026-10-02T00:00:00";
    data.orders![0]!.id = "";
    data.inventory![0]!.variantId = 5;
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(squarespaceDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.deadLettered).toBe(3);
    expect(report.ingested).toBe(4);
  });

  it("waits out a rate limit inside a sync, and says what the key can't read", async () => {
    const mock = squarespaceDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(7);
    expect(slept).toEqual([60_000, 60_000]);
    for (const [permissions, name] of [[["Inventory", "Orders"], "Products"], [["Products", "Orders"], "Inventory"], [["Products", "Inventory"], "Orders"]] as const) {
      await expect(drain(connector(squarespaceDocMock(account({ permissions: [...permissions] }))).historicalImport({ cursor: null } as never)), name).rejects.toThrow(`lacks Read Only permission for ${name} (HTTP 403)`);
    }
    await expect(drain(connector(squarespaceDocMock(account({ apiKey: ["o", "b".repeat(30)].join("") }))).historicalImport({ cursor: null } as never))).rejects.toThrow("turned down SQUARESPACE_API_KEY (HTTP 401)");
  });

  it("reads up to now when no clock is given", async () => {
    const mock = squarespaceDocMock(account());
    const before = Date.now();
    await drain(squarespaceConnector({ ...base(mock.fetch), customerKey: CUSTOMER_KEY }).historicalImport({ cursor: null } as never));
    const to = Date.parse(mock.reads[2]!.query.modifiedBefore!);
    expect(to).toBeGreaterThanOrEqual(before - 1);
    expect(to).toBeLessThanOrEqual(Date.now());
  });

  it("only ever lists products, stock and orders", async () => {
    const mock = squarespaceDocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`))).toEqual(new Set(["GET /v2/commerce/products", "GET /1.0/commerce/inventory", "GET /1.0/commerce/orders"]));
  });

  it("declares updating stock and fulfilling an order, each needing approval, and a read-only gate turns both down", async () => {
    const c = connector(squarespaceDocMock(account()));
    expect(c.source).toBe("squarespace");
    expect(c.writes).toBe(SQUARESPACE_WRITES);
    expect(SQUARESPACE_WRITES.map((w) => [w.integration, w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["squarespace", "update_stock", "update", "each", 20],
      ["squarespace", "fulfill_order", "update", "each", 20],
    ]);
    const refused = await assertWritesRefused(c);
    expect(refused.map((r) => r.action)).toEqual(["update_stock", "fulfill_order"]);
  });
});

describe("Squarespace doc mock", () => {
  it("checks the key, the User-Agent, its permissions, cursors and the window", async () => {
    const data = account();
    const mock = squarespaceDocMock(data);
    const get = (path: string, q: Record<string, string> = {}, headers: Record<string, string> = { authorization: `Bearer ${KEY_VALUE}`, "user-agent": "test" }) => mock.fetch(`https://api.squarespace.com${path}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`, { headers });
    expect((await get("/1.0/commerce/orders", {}, { "user-agent": "test" })).status).toBe(401);
    expect((await get("/1.0/commerce/orders", {}, { authorization: `Bearer ${KEY_VALUE}` })).status).toBe(400);
    expect(await (await get("/1.0/commerce/inventory", { x: "1" })).json()).toMatchObject({ type: "INVALID_REQUEST_ERROR" });
    expect((await get("/1.0/commerce/orders", { modifiedAfter: W.from })).status).toBe(400);
    expect((await get("/1.0/commerce/orders", { modifiedAfter: W.from, modifiedBefore: "soon" })).status).toBe(400);
    expect((await get("/1.0/commerce/orders", { modifiedBefore: W.to })).status).toBe(400);
    expect((await get("/1.0/commerce/orders", { cursor: "nope" })).status).toBe(400);
    expect((await get("/v2/commerce/products", { modifiedAfter: W.from, modifiedBefore: W.to })).status).toBe(400);
    const all = (await (await get("/1.0/commerce/orders")).json()) as { result: unknown[]; pagination: Record<string, unknown> };
    expect([all.result.length, all.pagination]).toEqual([2, { hasNextPage: false, nextPageCursor: null, nextPageUrl: null }]);
    // Strictly after, and up to and including.
    const exact = (await (await get("/1.0/commerce/orders", { modifiedAfter: "2026-10-02T00:00:00Z", modifiedBefore: "2026-10-03T00:00:00Z" })).json()) as { result: unknown[] };
    expect(exact.result).toHaveLength(1);
    data.orders![0]!.paymentState = "FAILED";
    expect(((await (await get("/1.0/commerce/orders")).json()) as { result: unknown[] }).result).toHaveLength(1);
    squarespaceStock.reset();
    data.inventory = squarespaceStock.many(51);
    const first = (await (await get("/1.0/commerce/inventory")).json()) as { inventory: unknown[]; pagination: { nextPageCursor: string; nextPageUrl: string } };
    expect(first.inventory).toHaveLength(50);
    expect(first.pagination.nextPageUrl).toBe(`https://api.squarespace.com/1.0/commerce/inventory?cursor=${first.pagination.nextPageCursor}`);
    expect((await get("/1.0/commerce/inventory", { cursor: first.pagination.nextPageCursor, x: "1" })).status).toBe(400);
    expect((await get("/v2/commerce/products", { cursor: first.pagination.nextPageCursor })).status).toBe(400);
    expect(((await (await get("/1.0/commerce/inventory", { cursor: first.pagination.nextPageCursor })).json()) as { inventory: unknown[] }).inventory).toHaveLength(1);
    expect((await get("/1.0/commerce/inventory", { cursor: Buffer.from("[1,2]").toString("base64url") })).status).toBe(400);
    const empty = squarespaceDocMock({ apiKey: KEY_VALUE, permissions: ["Products"] });
    expect(await (await empty.fetch("https://api.squarespace.com/v2/commerce/products", { headers: { authorization: `Bearer ${KEY_VALUE}`, "user-agent": "test" } })).json()).toEqual({ products: [], pagination: { hasNextPage: false, nextPageCursor: null, nextPageUrl: null } });
    expect((await empty.fetch("https://api.squarespace.com/1.0/commerce/orders", { headers: { authorization: `Bearer ${KEY_VALUE}`, "user-agent": "test" } })).status).toBe(403);
    const bare = squarespaceDocMock({ apiKey: KEY_VALUE });
    for (const [path, field] of [["/1.0/commerce/inventory", "inventory"], ["/1.0/commerce/orders", "result"]] as const) expect(((await (await bare.fetch(`https://api.squarespace.com${path}`, { headers: { authorization: `Bearer ${KEY_VALUE}`, "user-agent": "test" } })).json()) as Record<string, unknown[]>)[field], path).toEqual([]);
    await expect(mock.fetch("https://api.squarespace.com/1.0/commerce/inventory/adjustments", { method: "POST" })).rejects.toThrow("not in the vendor's docs");
  });
});
