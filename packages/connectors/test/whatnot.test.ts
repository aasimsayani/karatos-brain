import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  DOC_MOCK_MODULES,
  TEST_ORG,
  UndocumentedRequestError,
  WHATNOT_DOC_PAGES,
  assertSynthetic,
  checkConnectorSync,
  testPipeline,
  whatnotDocMock,
  whatnotOrder,
  whatnotOrderItem,
  whatnotProduct,
  whatnotVariant,
  type WhatnotMock,
  type WhatnotMockData,
  type WhatnotMockRecord,
} from "@karatos/connector-testkit";
import {
  WHATNOT_API_BASE,
  WHATNOT_PAGE_SIZE,
  WHATNOT_REVISIT_DAYS,
  WHATNOT_SCOPES,
  WHATNOT_USER_AGENT,
  WHATNOT_WRITES,
  WhatnotApiError,
  WhatnotConfigError,
  parseWhatnotCursor,
  whatnotClient,
  whatnotConnector,
  whatnotMoney,
  whatnotOrderEvents,
  whatnotProductEvents,
  whatnotSku,
  whatnotTime,
  type WhatnotClient,
  type WhatnotCursor,
  type WhatnotEvent,
  type WhatnotOptions,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["wn", "pat", "tk", "x".repeat(20)].join("_");
const BEARER = `Bearer ${TOKEN}`;
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
const HEADERS = { accept: "application/json", authorization: BEARER, "user-agent": WHATNOT_USER_AGENT };
const noSleep = async () => {};
const minutes = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 60_000).toISOString();
const daysAgo = (n: number) => new Date(Date.parse(RECEIVED) - n * 86_400_000).toISOString();

const reset = () => {
  for (const b of [whatnotOrder, whatnotOrderItem, whatnotProduct, whatnotVariant]) b.reset();
};
/** Three completed orders with one item each, and two products with one variant each. */
function account(overrides: Partial<WhatnotMockData> = {}): WhatnotMockData {
  reset();
  return { token: TOKEN, orders: whatnotOrder.many(3), items: whatnotOrderItem.many(3), products: whatnotProduct.many(2), variants: whatnotVariant.many(2), ...overrides };
}
/** Order 1 with overrides; its id stays 123401 unless given. */
const order = (over: WhatnotMockRecord = {}) => {
  reset();
  return { ...whatnotOrder.one(), ...over };
};
/** Item 1 (for order 123401) with overrides. */
const item = (over: WhatnotMockRecord = {}) => {
  reset();
  return { ...whatnotOrderItem.one(), ...over };
};
const product = (over: WhatnotMockRecord = {}) => {
  reset();
  return { ...whatnotProduct.one(), ...over };
};
const variant = (over: WhatnotMockRecord = {}) => {
  reset();
  return { ...whatnotVariant.one(), ...over };
};
/** An order with an explicit id and its one item, sold for $10. */
function sold(id: string, over: WhatnotMockRecord = {}): { order: WhatnotMockRecord; item: WhatnotMockRecord } {
  const ten = { amount: "10", currency: "USD" };
  return {
    order: order({ id, amounts: { subtotal: ten, shipping: { amount: "0", currency: "USD" }, tax: { amount: "0", currency: "USD" }, total: ten, applied_discount: null }, ...over }),
    item: item({ id: `9${id}`, order_id: id, unit_price: ten }),
  };
}
const connector = (mock: WhatnotMock, overrides: Partial<WhatnotOptions> = {}) => whatnotConnector({ accessToken: TOKEN, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as WhatnotEvent[];
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const reads = (mock: WhatnotMock) => mock.reads.map((r) => `${r.path} ${r.reverse ? "newest" : "oldest"} ${r.cursor === null ? "first" : "next"}`);

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
const empty = json(200, { data: [], next_cursor: null });
const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => {
  const slept: number[] = [];
  const c = whatnotClient({ accessToken: TOKEN, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const first = { cursor: null, reverse: false };

describe("Whatnot client", () => {
  it("checks its token before sending anything", () => {
    const message = "set WHATNOT_ACCESS_TOKEN to a Whatnot seller API token, which starts wn_pat_tk_ or wn_access_tk_";
    const bad = ["", "short", "x".repeat(40), ["wn", "pat", "tk", "x".repeat(7)].join("_"), ["wn", "pat", "tk", "x".repeat(513)].join("_"), ["wn", "key", "tk", "x".repeat(20)].join("_"), `Bearer ${TOKEN}`, `${TOKEN} more`, `${TOKEN}é`, undefined as unknown as string];
    for (const accessToken of bad) expect(() => whatnotClient({ accessToken }), String(accessToken).slice(0, 12)).toThrow(new WhatnotConfigError(message));
    for (const accessToken of [` ${TOKEN} `, ["wn", "access", "tk", "x".repeat(8)].join("_"), ["wn", "pat", "tk", "x".repeat(512)].join("_"), ["wn", "access", "tk", "test", "a-b.c~d+e/f="].join("_")]) {
      expect(() => whatnotClient({ accessToken }), accessToken.slice(0, 14)).not.toThrow();
    }
    expect(new WhatnotConfigError("x").name).toBe("WhatnotConfigError");
    expect(new WhatnotApiError("x", 500, "internal-error")).toMatchObject({ name: "WhatnotApiError", status: 500, type: "internal-error" });
    expect(WHATNOT_SCOPES).toEqual(["read:orders", "read:inventory"]);
  });

  it("sends only GETs of the four lists, 50 a page, with the bearer token and a User-Agent", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    await c.orders(first);
    await c.orders({ cursor: "a+b/c=", reverse: true });
    await c.orderItems("123401", null);
    await c.products({ cursor: "p2", reverse: false });
    await c.variants("12301", "v2");
    await client(fetch, { accessToken: `  ${TOKEN}\n` }).c.products({ cursor: null, reverse: true });
    expect(sent).toEqual([
      { url: `${WHATNOT_API_BASE}/orders?limit=50&reverse=false`, method: "GET", headers: HEADERS },
      { url: `${WHATNOT_API_BASE}/orders?limit=50&reverse=true&cursor=a%2Bb%2Fc%3D`, method: "GET", headers: HEADERS },
      { url: `${WHATNOT_API_BASE}/orders/123401/items?limit=50&reverse=false`, method: "GET", headers: HEADERS },
      { url: `${WHATNOT_API_BASE}/products?limit=50&reverse=false&cursor=p2`, method: "GET", headers: HEADERS },
      { url: `${WHATNOT_API_BASE}/products/12301/variants?limit=50&reverse=false&cursor=v2`, method: "GET", headers: HEADERS },
      { url: `${WHATNOT_API_BASE}/products?limit=50&reverse=true`, method: "GET", headers: HEADERS },
    ]);
    expect(WHATNOT_API_BASE).toBe("https://api.whatnot.com/seller-api/rest/v2");
    expect(WHATNOT_PAGE_SIZE).toBe(50);
    expect(WHATNOT_USER_AGENT).toBe("KaratOS/1.0 (+https://github.com/aasimsayani/karatos-brain)");
    expect(Object.keys(c).sort()).toEqual(["orderItems", "orders", "products", "variants"]);
  });

  it("turns down an id or cursor it wasn't made for, before sending anything", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    for (const id of ["0", "0123", "abc", "1".repeat(20), "1 2", "../1", ""]) await expect(c.orderItems(id, null), id).rejects.toThrow(new WhatnotApiError("an order id must be a number Whatnot gave", 0));
    for (const id of ["a b", "../x", "p".repeat(65), "", "a/b"]) await expect(c.variants(id, null), id).rejects.toThrow(new WhatnotApiError("a product id must be one Whatnot gave", 0));
    for (const cursor of ["", "c".repeat(2049), 5 as unknown as string]) await expect(c.orders({ cursor, reverse: true }), String(cursor).slice(0, 5)).rejects.toThrow(new WhatnotApiError("a cursor for the orders must be 1 to 2048 characters", 0));
    await expect(c.orderItems("123401", "")).rejects.toThrow("a cursor for the order items must be 1 to 2048 characters");
    expect(sent).toHaveLength(0);
    await c.orders({ cursor: "c".repeat(2048), reverse: true });
    await c.orderItems("1".repeat(19), null);
    await c.variants("p".repeat(64), null);
    expect(sent).toHaveLength(3);
  });

  it("explains a token Whatnot turns down, and other answers", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.orders(first);
    const scopes = "WHATNOT_ACCESS_TOKEN must be a Whatnot seller API token with the read:orders and read:inventory scopes";
    await expect(at(json(401, { type: "unauthenticated", title: "Unauthenticated", status: 401, detail: "A valid seller API token is required." }))).rejects.toThrow(
      new WhatnotConfigError(`Whatnot turned down the access token (HTTP 401) (unauthenticated): A valid seller API token is required.; ${scopes}`),
    );
    await expect(at(json(403, { type: "missing-scope", title: "Missing scope", status: 403, required_scopes: ["read:inventory"] }))).rejects.toThrow(
      new WhatnotConfigError(`Whatnot turned down the access token (HTTP 403) (missing-scope): Missing scope; ${scopes}`),
    );
    await expect(at(json(403, { type: "Seller Not Approved" }))).rejects.toThrow(new WhatnotConfigError(`Whatnot turned down the access token (HTTP 403); ${scopes}`));
    await expect(at(() => new Response("nope", { status: 401 }))).rejects.toBeInstanceOf(WhatnotConfigError);
    await expect(at(json(404, { type: "endpoint-not-found", detail: "d".repeat(250) }))).rejects.toThrow(new WhatnotApiError(`Whatnot answered HTTP 404 for the orders (endpoint-not-found): ${"d".repeat(200)}`, 404, "endpoint-not-found"));
    await expect(at(json(422, { detail: [{ loc: ["query", "limit"], msg: "too big", type: "less_than_equal" }] }))).rejects.toThrow(/^Whatnot answered HTTP 422 for the orders$/);
    await expect(at(json(400, { type: "about:blank", title: "Bad request" }))).rejects.toMatchObject({ message: "Whatnot answered HTTP 400 for the orders: Bad request", type: undefined });
    await expect(at(json(400, { type: "t".repeat(65) }))).rejects.toMatchObject({ type: undefined });
    await expect(at(json(202, {}))).rejects.toMatchObject({ status: 202 });
    await expect(at(json(500, null))).rejects.toThrow(/^Whatnot answered HTTP 500 for the orders$/);
    for (const body of [null, [], 5, {}, { data: 5 }, { data: {} }, { data: [], next_cursor: 5 }, { data: [], next_cursor: "" }, { data: [], next_cursor: "c".repeat(2049) }]) {
      await expect(at(json(200, body)), JSON.stringify(body).slice(0, 40)).rejects.toThrow(new WhatnotApiError("Whatnot answered the orders without a page that reads", 200));
    }
    await expect(at(() => new Response("{", { status: 200 }))).rejects.toThrow("without a page that reads");
    expect(await at(json(200, { data: [{ id: "1" }] }))).toEqual({ data: [{ id: "1" }], nextCursor: null });
    expect(await at(json(200, { data: [], next_cursor: null }))).toEqual({ data: [], nextCursor: null });
    expect(await at(json(200, { data: [], next_cursor: "n" }))).toEqual({ data: [], nextCursor: "n" });
    const same = client(scripted([json(200, { data: [], next_cursor: "c1" })]).fetch).c;
    await expect(same.products({ cursor: "c1", reverse: false })).rejects.toThrow(new WhatnotApiError("Whatnot answered the products with the same cursor again", 200));
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([json(status, { type: "rate-limited" }, headers), empty]);
      const { c, slept } = client(fetch);
      await c.orders(first);
      expect(sent).toHaveLength(2);
      return slept;
    };
    expect(await waits({ "retry-after": "1" })).toEqual([1000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits({ "retry-after": value }), value).toEqual([1000]);
    expect(await waits({})).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "3" }, status), String(status)).toEqual([3000]);
    const { fetch, sent } = scripted([json(503, { type: "service-unavailable" })]);
    const { c, slept } = client(fetch);
    await expect(c.orders(first)).rejects.toMatchObject({ status: 503, type: "service-unavailable" });
    expect([sent.length, slept]).toEqual([4, [1000, 2000, 4000]]);
    const once = scripted([json(501, {})]);
    await expect(client(once.fetch).c.orders(first)).rejects.toMatchObject({ status: 501 });
    expect(once.sent).toHaveLength(1);
    const one = scripted([json(429, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.orders(first)).rejects.toMatchObject({ status: 429 });
    expect(one.sent).toHaveLength(2);
    const unauthorized = scripted([json(401, {})]);
    await expect(client(unauthorized.fetch).c.orders(first)).rejects.toBeInstanceOf(WhatnotConfigError);
    expect(unauthorized.sent).toHaveLength(1);
  });

  it("works with the default sleep and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([json(429, {}, { "retry-after": "0" }), empty]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await whatnotClient({ accessToken: TOKEN }).orders(first);
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Whatnot events", () => {
  it("reads money, times and SKUs as Whatnot writes them", () => {
    expect(whatnotMoney({ amount: "42", currency: "USD" })).toEqual({ cents: 4200, currency: "USD" });
    expect(whatnotMoney({ amount: "49.77", currency: "USD" })).toEqual({ cents: 4977, currency: "USD" });
    expect(whatnotMoney({ amount: "42.00", currency: "CAD" })).toEqual({ cents: 4200, currency: "CAD" });
    expect(whatnotMoney({ amount: "0.5", currency: "GBP" })).toEqual({ cents: 50, currency: "GBP" });
    expect(whatnotMoney({ amount: "0", currency: "USD" })).toEqual({ cents: 0, currency: "USD" });
    expect(whatnotMoney({ amount: "9999999999999.99", currency: "USD" })).toEqual({ cents: 999_999_999_999_999, currency: "USD" });
    const bad = [null, [], "42", { amount: 42, currency: "USD" }, { amount: "42.999", currency: "USD" }, { amount: "-1", currency: "USD" }, { amount: "01", currency: "USD" }, { amount: "1.", currency: "USD" }, { amount: "1,00", currency: "USD" }, { amount: "1e3", currency: "USD" }, { amount: "10000000000000", currency: "USD" }, { amount: " 1", currency: "USD" }, { amount: "1", currency: "usd" }, { amount: "1", currency: "US" }, { amount: "1" }];
    for (const m of bad) expect(whatnotMoney(m), JSON.stringify(m)).toBeUndefined();
    expect(whatnotTime("2026-09-21T12:00:00.000Z")).toBe("2026-09-21T12:00:00.000Z");
    expect(whatnotTime("2026-09-21T12:00Z")).toBe("2026-09-21T12:00:00.000Z");
    expect(whatnotTime("2026-09-21T12:00:00+02:00")).toBe("2026-09-21T10:00:00.000Z");
    for (const t of ["2026-09-21", "2026-09-21T12:00:00", "x2026-09-21T12:00:00Z", "2026-13-01T00:00:00Z", null, 5]) expect(whatnotTime(t), String(t)).toBeUndefined();
    expect(whatnotSku("  RING-1  ", "v-1", "p-1")).toBe("RING-1");
    expect(whatnotSku("s".repeat(150), "v-1", "p-1")).toBe("s".repeat(100));
    expect(whatnotSku("", "v-1", "p-1")).toBe("whatnot-variant-v-1");
    expect(whatnotSku(null, "a b", "p-1")).toBe("whatnot-product-p-1");
    expect(whatnotSku(5, null, null)).toBeUndefined();
  });

  it("reads a completed order as its state and a sale, without the buyer or descriptions", () => {
    const events = whatnotOrderEvents(order(), [item()], RECEIVED).map((r) => r.event);
    expect(events).toEqual([
      {
        id: "whatnot_order_123401_completed_2026-01-01T01_30_00.000Z",
        type: "order.updated",
        occurredAt: minutes(90),
        receivedAt: RECEIVED,
        idempotencyKey: "whatnot:order:123401:completed:2026-01-01T01:30:00.000Z",
        payload: {
          system: "Whatnot",
          orderId: "whatnot:order:123401",
          createdAt: minutes(60),
          status: "COMPLETED",
          paid: true,
          shipped: true,
          cancelled: false,
          channel: "event",
          marketplace: "whatnot",
          transactionType: "auction",
          showId: "whatnot:show:show-1",
          currency: "USD",
          subtotalCents: 4100,
          shippingCents: 599,
          taxCents: 378,
          totalCents: 5077,
          lineCount: 1,
          linesComplete: true,
        },
      },
      {
        id: "whatnot_sale_123401",
        type: "sale.completed",
        occurredAt: minutes(60),
        receivedAt: RECEIVED,
        idempotencyKey: "whatnot:sale:123401",
        payload: { saleId: "whatnot:order:123401", channel: "event", lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 4100, discountCents: 0 }], totalCents: 5077, payments: [{ method: "other", amountCents: 5077 }] },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/buyer|6701|Test Customer|description|dashboard|Test ring/);
  });

  it("maps each status, and only a sold order is a sale", () => {
    const at = (status: unknown, over: WhatnotMockRecord = {}) => whatnotOrderEvents(order({ status, ...over }), [item()], RECEIVED).map((r) => r.event);
    const table = ["pending", "pending_fulfillment", "completed", "cancelled", "failed"].map((status) => {
      const events = at(status);
      const p = events[0]!.payload;
      return [status, p.status, p.paid, p.shipped, p.cancelled, events.map((e) => e.type)];
    });
    expect(table).toEqual([
      ["pending", "PENDING", false, false, false, ["order.updated"]],
      ["pending_fulfillment", "PENDING_FULFILLMENT", true, false, false, ["order.updated", "sale.completed"]],
      ["completed", "COMPLETED", true, true, false, ["order.updated", "sale.completed"]],
      ["cancelled", "CANCELLED", false, false, true, ["order.updated", "sale.completed", "sale.returned"]],
      ["failed", "FAILED", false, false, false, ["order.updated"]],
    ]);
    const keys = ["pending", "pending_fulfillment", "completed", "cancelled", "failed"].map((s) => at(s)[0]!.idempotencyKey);
    expect(new Set(keys).size).toBe(5);
    expect(at("completed", { updated_at: minutes(999) })[0]!.idempotencyKey).toBe("whatnot:order:123401:completed:2026-01-01T16:39:00.000Z");
    expect(at("completed", { updated_at: null })[0]).toMatchObject({ idempotencyKey: "whatnot:order:123401:completed:2026-01-01T01:00:00.000Z", occurredAt: minutes(60) });
    expect(at("completed", { created_at: null })[1]!.occurredAt).toBe(minutes(90));
    expect(at("completed", { updated_at: minutes(999) })[1]!.idempotencyKey).toBe(at("pending_fulfillment")[1]!.idempotencyKey);
    expect(at("completed", { show_id: null }).map((e) => e.payload.channel)).toEqual(["online", "online"]);
    expect(at("completed", { show_id: "a b" })[0]!.payload).not.toHaveProperty("showId");
    for (const transaction_type of ["buy_it_now", "giveaway", "other"]) expect(at("completed", { transaction_type })[0]!.payload.transactionType).toBe(transaction_type);
    for (const transaction_type of [null, "raffle", "constructor"]) expect(at("completed", { transaction_type })[0]!.payload).not.toHaveProperty("transactionType");
  });

  it("nets a cancelled order to zero with a return keyed by order", () => {
    const two = [item({ quantity: 2 }), item({ id: "987699", unit_price: { amount: "5.50", currency: "USD" }, purchased_item: null, variant_id: "v-9" })];
    const events = whatnotOrderEvents(order({ status: "cancelled", cancelled_at: minutes(120) }), two, RECEIVED).map((r) => r.event);
    expect(events[0]!.payload).toMatchObject({ cancelled: true, cancelledAt: minutes(120), lineCount: 2 });
    expect(events[1]!.payload.lines).toEqual([
      { sku: "SKU-TEST-0001", quantity: 2, unitPriceCents: 4100, discountCents: 0 },
      { sku: "whatnot-variant-v-9", quantity: 1, unitPriceCents: 550, discountCents: 0 },
    ]);
    expect(events[2]).toEqual({
      id: "whatnot_return_123401",
      type: "sale.returned",
      occurredAt: minutes(120),
      receivedAt: RECEIVED,
      idempotencyKey: "whatnot:return:123401",
      payload: { saleId: "whatnot:order:123401", returnId: "whatnot:return:123401", lines: [{ sku: "SKU-TEST-0001", quantity: 2, refundCents: 8200 }, { sku: "whatnot-variant-v-9", quantity: 1, refundCents: 550 }], reason: "cancelled" },
    });
    // The sale's key is the one the order had before it was cancelled, so a sale seen earlier isn't counted twice.
    expect(events[1]!.idempotencyKey).toBe(whatnotOrderEvents(order(), [item()], RECEIVED)[1]!.event.idempotencyKey);
    expect(whatnotOrderEvents(order({ status: "cancelled" }), [item()], RECEIVED)[2]!.event.occurredAt).toBe(minutes(90));
    expect(whatnotOrderEvents(order({ status: "cancelled", updated_at: null }), [item()], RECEIVED)[2]!.event.occurredAt).toBe(minutes(60));
  });

  it("keeps the discount, and leaves out an amount in another currency or that doesn't read", () => {
    const amounts = (over: WhatnotMockRecord) => ({ ...(order().amounts as WhatnotMockRecord), ...over });
    const payload = (over: WhatnotMockRecord) => whatnotOrderEvents(order({ amounts: amounts(over) }), [item()], RECEIVED)[0]!.event.payload;
    expect(payload({ applied_discount: { amount: { amount: "2", currency: "USD" }, type: "fixed_price" } }).discountCents).toBe(200);
    expect(payload({ applied_discount: { percent: 10, type: "percentage" } })).not.toHaveProperty("discountCents");
    expect(payload({ tax: { amount: "1", currency: "CAD" }, shipping: { amount: "x", currency: "USD" }, subtotal: null })).not.toHaveProperty("taxCents");
    expect(payload({ shipping: { amount: "x", currency: "USD" } })).not.toHaveProperty("shippingCents");
    expect(payload({ subtotal: null })).not.toHaveProperty("subtotalCents");
  });

  it("makes no sale of a giveaway with nothing paid", () => {
    const zero = { amount: "0", currency: "USD" };
    const events = whatnotOrderEvents(order({ transaction_type: "giveaway", amounts: { subtotal: zero, shipping: zero, tax: zero, total: zero, applied_discount: null } }), [item({ unit_price: zero })], RECEIVED);
    expect(events.map((r) => [r.ok, r.event.type])).toEqual([[true, "order.updated"]]);
    expect(events[0]!.event.payload.totalCents).toBe(0);
  });

  it("dead-letters an order that doesn't read, with nothing else", () => {
    const problems = (raw: unknown, items: unknown[] = [item()]) => {
      const reads = whatnotOrderEvents(raw, items, RECEIVED);
      const r = reads[0]!;
      expect(r.event.occurredAt === undefined).toBe(!r.ok);
      if (!r.ok) expect(reads).toHaveLength(1);
      return r.ok ? [] : (r.event.payload.problems as string[]);
    };
    expect(problems(null)).toEqual(["order is not an object", "order has no id that reads", "order has no status that reads", "order has no total that reads", "order has no time that reads"]);
    expect(problems([])).toContain("order is not an object");
    expect(problems(order({ id: 123401 }))).toEqual(["order has no id that reads"]);
    expect(problems(order({ id: "0123" }))).toEqual(["order has no id that reads"]);
    expect(problems(order({ status: "shipped" }))).toEqual(["order has no status that reads"]);
    expect(problems(order({ status: "constructor" }))).toEqual(["order has no status that reads"]);
    expect(problems(order({ amounts: { total: { amount: "49.777", currency: "USD" } } }))).toEqual(["order has no total that reads"]);
    expect(problems(order({ amounts: null }))).toEqual(["order has no total that reads"]);
    expect(problems(order({ created_at: null, updated_at: "soon" }))).toEqual(["order has no time that reads"]);
    const dead = whatnotOrderEvents(order({ status: 5 }), [item()], RECEIVED)[0]!.event;
    expect(dead).toMatchObject({ type: "order.updated", idempotencyKey: expect.stringMatching(/^whatnot:unreadable_order:[0-9a-f]{12}$/), payload: { system: "Whatnot", kind: "order", problems: ["order has no status that reads"] } });
    expect(dead.id).toBe(dead.idempotencyKey.replace(/:/g, "_"));
    expect(whatnotOrderEvents(order({ status: 6 }), [item()], RECEIVED)[0]!.event.idempotencyKey).not.toBe(dead.idempotencyKey);
    expect(whatnotOrderEvents(order({ status: 5 }), [item()], RECEIVED)[0]!.event.idempotencyKey).toBe(dead.idempotencyKey);
  });

  it("keeps the order but dead-letters a sale whose lines don't all read", () => {
    const sale = (items: unknown[], status = "completed") => {
      const reads = whatnotOrderEvents(order({ status }), items, RECEIVED);
      expect(reads[0]!.ok).toBe(true);
      expect(reads[0]!.event.payload.linesComplete).toBe(false);
      expect(reads).toHaveLength(2);
      expect(reads[1]!.ok).toBe(false);
      expect(reads[1]!.event).toMatchObject({ type: "sale.completed", occurredAt: undefined, idempotencyKey: expect.stringMatching(/^whatnot:unreadable_sale:[0-9a-f]{12}$/) });
      return reads[1]!.event.payload.problems as string[];
    };
    expect(sale([])).toEqual(["order has no line items"]);
    expect(sale([null])).toEqual(["line 1 is not an object"]);
    expect(sale([item(), []])).toEqual(["line 2 is not an object"]);
    expect(sale([item({ purchased_item: null, variant_id: null, product_id: 5 })])).toEqual(["line 1 has no SKU, variant or product that reads"]);
    expect(sale([item({ quantity: 0 })])).toEqual(["line 1 has no quantity that reads"]);
    expect(sale([item({ quantity: 1.5 })])).toEqual(["line 1 has no quantity that reads"]);
    expect(sale([item({ unit_price: { amount: "x", currency: "USD" } })])).toEqual(["line 1 has no unit price that reads"]);
    expect(sale([item({ unit_price: { amount: "41", currency: "CAD" } })])).toEqual(["line 1 is not in the order's currency"]);
    expect(sale([item({ quantity: "1" })], "cancelled")).toEqual(["line 1 has no quantity that reads"]);
    // A pending order is no sale, so its lines aren't checked.
    expect(whatnotOrderEvents(order({ status: "pending" }), [], RECEIVED).map((r) => r.ok)).toEqual([true]);
    expect(whatnotOrderEvents(order({ status: "pending" }), [null], RECEIVED)[0]!.event.payload).toMatchObject({ lineCount: 1, linesComplete: false });
  });

  it("reads a product with its variants, and each variant's stock", () => {
    const events = whatnotProductEvents(product(), [variant(), variant({ id: "variant-9", sku: "", price: null, inventory: { available_quantity: 0 } })], RECEIVED).map((r) => r.event);
    const at = minutes(1500);
    expect(events[0]).toMatchObject({
      type: "product.updated",
      occurredAt: at,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^whatnot:product:12301:[0-9a-f]{16}$/),
      payload: {
        productId: "whatnot:product:12301",
        title: "Test ring 1",
        status: "ACTIVE",
        vendor: null,
        productType: "Jewelry",
        tags: [],
        variants: [
          { variantId: "whatnot:variant:variant-1", sku: "SKU-TEST-0001", priceCents: 4150, inventoryQuantity: 1 },
          { variantId: "whatnot:variant:variant-9", sku: "whatnot-variant-variant-9", priceCents: null, inventoryQuantity: 0 },
        ],
      },
    });
    expect(events.slice(1)).toEqual([
      { id: `whatnot_count_variant-1_1_${at.replace(/:/g, "_")}`, type: "inventory.counted", occurredAt: at, receivedAt: RECEIVED, idempotencyKey: `whatnot:count:variant-1:1:${at}`, payload: { sku: "SKU-TEST-0001", onHand: 1, variantId: "whatnot:variant:variant-1" } },
      { id: `whatnot_count_variant-9_0_${at.replace(/:/g, "_")}`, type: "inventory.counted", occurredAt: at, receivedAt: RECEIVED, idempotencyKey: `whatnot:count:variant-9:0:${at}`, payload: { sku: "whatnot-variant-variant-9", onHand: 0, variantId: "whatnot:variant:variant-9" } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/description|cdn\.whatnot|ext-/);
    const key = (p: unknown, v: unknown[]) => whatnotProductEvents(p, v, RECEIVED)[0]!.event.idempotencyKey;
    expect(key(product(), [variant()])).toBe(key(product({ description: "changed" }), [variant()]));
    expect(key(product(), [variant()])).not.toBe(key(product(), [variant({ price: { amount: "1", currency: "USD" } })]));
    expect(whatnotProductEvents(product(), [variant({ inventory: { available_quantity: 7 } })], RECEIVED)[1]!.event.idempotencyKey).toBe(`whatnot:count:variant-1:7:${at}`);
  });

  it("falls back for a product's title, type and time, and never invents a count", () => {
    const [p, count] = whatnotProductEvents(product({ title: " ", category: null, updated_at: null }), [variant({ inventory: { available_quantity: -1 } })], RECEIVED);
    expect(p!.event).toMatchObject({ occurredAt: minutes(1440), payload: { title: "Whatnot product 12301", productType: null } });
    expect(count!.ok).toBe(false);
    expect(count!.event).toMatchObject({ type: "inventory.counted", occurredAt: undefined, idempotencyKey: expect.stringMatching(/^whatnot:unreadable_count:[0-9a-f]{12}$/), payload: { system: "Whatnot", kind: "count", problems: ["variant has no available quantity that reads"] } });
    for (const inventory of [null, {}, { available_quantity: "3" }, { available_quantity: 1.5 }]) expect(whatnotProductEvents(product(), [variant({ inventory })], RECEIVED)[1]!.ok, JSON.stringify(inventory)).toBe(false);
    const undated = whatnotProductEvents(product({ created_at: null, updated_at: null }), [variant()], RECEIVED).map((r) => r.event);
    expect(undated[0]!.occurredAt).toBe(RECEIVED);
    expect(undated[1]!.idempotencyKey).toBe("whatnot:count:variant-1:1:unknown");
    expect(whatnotProductEvents(product(), [], RECEIVED).map((r) => r.event.type)).toEqual(["product.updated"]);
  });

  it("dead-letters a product that doesn't read, or has a variant without an id", () => {
    const problems = (raw: unknown, variants: unknown[] = []) => {
      const reads = whatnotProductEvents(raw, variants, RECEIVED);
      if (!reads[0]!.ok) expect(reads).toHaveLength(1);
      return reads[0]!.ok ? [] : (reads[0]!.event.payload.problems as string[]);
    };
    expect(problems(null)).toEqual(["product is not an object", "product has no id that reads"]);
    expect(problems([])).toEqual(["product is not an object", "product has no id that reads"]);
    expect(problems(product({ id: 12301 }))).toEqual(["product has no id that reads"]);
    expect(problems(product({ id: "p".repeat(65) }))).toEqual(["product has no id that reads"]);
    expect(problems(product({ id: "p".repeat(64) }))).toEqual([]);
    expect(problems(product(), [variant({ id: null })])).toEqual(["variant 1 has no id that reads"]);
    expect(problems(product(), [variant(), "x"])).toEqual(["variant 2 has no id that reads"]);
    const dead = whatnotProductEvents(product({ id: "a b" }), [], RECEIVED)[0]!.event;
    expect(dead).toMatchObject({ type: "product.updated", occurredAt: undefined, idempotencyKey: expect.stringMatching(/^whatnot:unreadable_product:[0-9a-f]{12}$/) });
  });
});

describe("Whatnot connector", () => {
  it("passes the shared sync checks", async () => {
    // Three orders, each its state and sale (6), and two products, each with one variant's count (4).
    const result = await checkConnectorSync({ makeConnector: () => connector(whatnotDocMock(account())), payloadSchemas: SCHEMAS, expected: { ingested: 10 } });
    expect(result.full.batches).toBe(2);
    expect(parseWhatnotCursor(result.full.cursor)).toEqual({ done: true, step: null, page: null });
  });

  it("imports every order oldest first with all its items, then every product, and stops for good", async () => {
    reset();
    const orders = whatnotOrder.many(WHATNOT_PAGE_SIZE + 1);
    const items = whatnotOrderItem.many(WHATNOT_PAGE_SIZE + 1);
    // Order 1 has 51 more items, so its items take two pages.
    const extra = Array.from({ length: WHATNOT_PAGE_SIZE + 1 }, (_, i) => ({ ...items[0]!, id: String(800000 + i) }));
    const mock = whatnotDocMock({ token: TOKEN, orders: [...orders].reverse(), items: [...items, ...extra], products: whatnotProduct.many(1), variants: whatnotVariant.many(1) });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 2 * (WHATNOT_PAGE_SIZE + 1) + 2, deadLettered: 0, batches: 3 });
    expect(reads(mock)).toEqual([
      "/orders oldest first",
      "/orders/123401/items oldest first",
      "/orders/123401/items oldest next",
      ...Array.from({ length: WHATNOT_PAGE_SIZE - 1 }, (_, i) => `/orders/${123402 + i}/items oldest first`),
      "/orders oldest next",
      "/orders/123451/items oldest first",
      "/products oldest first",
      "/products/12301/variants oldest first",
    ]);
    expect(mock.reads.every((r) => r.limit === 50)).toBe(true);
    const sales = memory.events.filter((e) => e.type === "sale.completed");
    expect(sales[0]!.payload).toMatchObject({ saleId: "whatnot:order:123401" });
    expect((sales[0]!.payload.lines as unknown[]).length).toBe(WHATNOT_PAGE_SIZE + 2);
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.stringify(memory.events.map((e) => e.payload))).not.toMatch(/buyer|Test Customer|description/);
    expect(parseWhatnotCursor(report.cursor)).toEqual({ done: true, step: null, page: null });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, mock.reads.length]).toEqual([0, 56]);
  });

  it("checkpoints each page with Whatnot's cursor, and resumes the import from it", async () => {
    reset();
    const data: WhatnotMockData = { token: TOKEN, orders: whatnotOrder.many(WHATNOT_PAGE_SIZE + 1), items: whatnotOrderItem.many(WHATNOT_PAGE_SIZE + 1), products: whatnotProduct.many(WHATNOT_PAGE_SIZE + 1), variants: [] };
    const all = await drain(connector(whatnotDocMock(data)).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const cursors = all.map((b) => parseWhatnotCursor(b.cursor)!);
    expect(cursors.map((c) => [c.done, c.step, c.page === null])).toEqual([
      [false, "orders", false],
      [false, "products", true],
      [false, "products", false],
      [true, null, true],
    ]);
    const mock = whatnotDocMock(data);
    const resumed = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: all[0]!.cursor }));
    expect(reads(mock).filter((r) => !r.includes("/items") && !r.includes("/variants"))).toEqual(["/orders oldest next", "/products oldest first", "/products oldest next"]);
    expect(mock.reads[0]!.cursor).toBe(cursors[0]!.page);
    expect(eventsOf(resumed).filter((e) => e.type === "order.updated").map((e) => e.payload.orderId)).toEqual(["whatnot:order:123451"]);
    const atProducts = whatnotDocMock(data);
    await drain(connector(atProducts).historicalImport({ organizationId: TEST_ORG, cursor: all[2]!.cursor }));
    expect(reads(atProducts)).toEqual(["/products oldest next", "/products/12351/variants oldest first"]);
    const done = whatnotDocMock(data);
    expect(await drain(connector(done).historicalImport({ organizationId: TEST_ORG, cursor: all[3]!.cursor }))).toEqual([]);
    expect(done.reads).toEqual([]);
  });

  it("reads orders newest first on each later sync, stopping after a page all older than 60 days", async () => {
    reset();
    // 50 recent orders, then 50 older than the edge, then 10 older still, which are never read.
    const ages = [...Array.from({ length: 50 }, (_, i) => 1 + i), ...Array.from({ length: 50 }, (_, i) => 61 + i), ...Array.from({ length: 10 }, (_, i) => 200 + i)];
    const pairs = ages.map((age, i) => sold(String(300000 + i), { created_at: daysAgo(age), updated_at: daysAgo(age) }));
    const data = (): WhatnotMockData => ({ token: TOKEN, orders: pairs.map((p) => p.order), items: pairs.map((p) => p.item), products: [product()], variants: [variant()] });
    const mock = whatnotDocMock(data());
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(WHATNOT_REVISIT_DAYS).toBe(60);
    expect(reads(mock).filter((r) => !r.includes("/items"))).toEqual(["/orders newest first", "/orders newest next", "/products oldest first", "/products/12301/variants oldest first"]);
    expect(report).toMatchObject({ ingested: 2 * 100 + 2, deadLettered: 0 });
    expect(memory.events.find((e) => e.type === "order.updated")!.payload.orderId).toBe("whatnot:order:300000");
    expect(parseWhatnotCursor(report.cursor)).toEqual({ done: true, step: null, page: null });
    // Nothing changed: everything comes back a duplicate. One order cancelled: its state and return are new.
    const again = await runSync({ connector: connector(whatnotDocMock(data())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, again.duplicates]).toEqual([0, 202]);
    pairs[3]!.order.status = "cancelled";
    pairs[3]!.order.updated_at = daysAgo(0);
    const changed = await runSync({ connector: connector(whatnotDocMock(data())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([changed.ingested, changed.duplicates]).toEqual([2, 201]);
    expect(memory.events.filter((e) => e.type === "sale.returned").map((e) => e.payload.saleId)).toEqual(["whatnot:order:300003"]);
  });

  it("reads on past a page holding an order created at the 60-day edge, or with no creation time", async () => {
    const pageOf = (created: (i: number) => unknown) => Array.from({ length: WHATNOT_PAGE_SIZE }, (_, i) => sold(String(400000 + i), { created_at: created(i) }));
    const run = async (pairs: { order: WhatnotMockRecord; item: WhatnotMockRecord }[]) => {
      const extra = sold("499999", { created_at: daysAgo(400) });
      const mock = whatnotDocMock({ token: TOKEN, orders: [extra.order, ...pairs.map((p) => p.order)], items: [extra.item, ...pairs.map((p) => p.item)] });
      await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
      return reads(mock).filter((r) => r.startsWith("/orders ")).length;
    };
    expect(await run(pageOf(() => daysAgo(61)))).toBe(1);
    expect(await run(pageOf((i) => (i === 0 ? daysAgo(WHATNOT_REVISIT_DAYS) : daysAgo(61))))).toBe(2);
    expect(await run(pageOf((i) => (i === 0 ? new Date(Date.parse(daysAgo(WHATNOT_REVISIT_DAYS)) - 1).toISOString() : daysAgo(61))))).toBe(1);
    expect(await run(pageOf((i) => (i === 49 ? null : daysAgo(61))))).toBe(2);
  });

  it("resumes a later sync at its saved page, and starts a fresh pass after a finished one", async () => {
    const data = account();
    const saved: WhatnotCursor = { done: false, step: "products", page: null };
    const mock = whatnotDocMock(data);
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(reads(mock)).toEqual(["/products oldest first", "/products/12301/variants oldest first", "/products/12302/variants oldest first"]);
    const fresh = whatnotDocMock(data);
    const batches = await drain(connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: true, step: null, page: null }) }));
    expect(reads(fresh)[0]).toBe("/orders newest first");
    expect(batches.map((b) => parseWhatnotCursor(b.cursor))).toEqual([
      { done: false, step: "products", page: null },
      { done: true, step: null, page: null },
    ]);
    // A cursor Whatnot gave is sent back as it was.
    const fake: WhatnotClient = {
      orders: async ({ cursor, reverse }) => (expect([cursor, reverse]).toEqual(["opaque-1", true]), { data: [], nextCursor: null }),
      orderItems: async () => ({ data: [], nextCursor: null }),
      products: async () => ({ data: [], nextCursor: null }),
      variants: async () => ({ data: [], nextCursor: null }),
    };
    const out = await drain(whatnotConnector({ accessToken: TOKEN, client: fake, now: NOW }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ done: false, step: "orders", page: "opaque-1" }) }));
    expect(out).toHaveLength(2);
  });

  it("keeps what doesn't read as dead letters, and skips the items of an order without an id", async () => {
    const data = account();
    data.orders![0] = { ...data.orders![0]!, status: "?" };
    data.orders!.push({ ...data.orders![1]!, id: null, created_at: minutes(5000) });
    data.products![1] = { ...data.products![1]!, id: "a b" };
    const mock = whatnotDocMock(data);
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Two orders and one product that read (2 + 2 + 2), and two orders and a product that don't.
    expect(report).toMatchObject({ ingested: 6, deadLettered: 3 });
    expect(reads(mock).filter((r) => r.includes("/items") || r.includes("/variants"))).toEqual(["/orders/123401/items oldest first", "/orders/123402/items oldest first", "/orders/123403/items oldest first", "/products/12301/variants oldest first"]);
  });

  it("stops on a token Whatnot turns down, or one without read:inventory, explaining the scopes", async () => {
    const wrong = whatnotDocMock({ ...account(), token: ["wn", "pat", "tk", "y".repeat(20)].join("_") });
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(wrong), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep })).rejects.toThrow(WhatnotConfigError);
    expect(await memory.getCheckpoint(TEST_ORG, "whatnot", "historical")).toBeNull();
    expect(wrong.reads).toHaveLength(0);
    const narrow = whatnotDocMock(account({ scopes: ["read:orders"] }));
    const error = await drain(connector(narrow).historicalImport({ organizationId: TEST_ORG, cursor: null })).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(WhatnotConfigError);
    expect(error!.message).toBe("Whatnot turned down the access token (HTTP 403) (missing-scope): This request requires read:inventory.; WHATNOT_ACCESS_TOKEN must be a Whatnot seller API token with the read:orders and read:inventory scopes");
    expect(error!.message).not.toContain(TOKEN);
    expect(reads(narrow).filter((r) => r.startsWith("/orders "))).toEqual(["/orders oldest first"]);
  });

  it("waits out Whatnot's rate limit and carries on", async () => {
    const slept: number[] = [];
    const mock = whatnotDocMock(account({ rateLimits: 2 }));
    const events = eventsOf(await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).historicalImport({ organizationId: TEST_ORG, cursor: null })));
    expect([events.length, slept]).toEqual([10, [1000, 1000]]);
  });

  it("uses the real clock by default, and declares its write, turned down", async () => {
    const before = Date.now();
    const out = await drain(whatnotConnector({ accessToken: TOKEN, fetch: whatnotDocMock(account()).fetch, sleep: noSleep }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(Date.parse(eventsOf(out)[0]!.receivedAt)).toBeGreaterThanOrEqual(before);
    const c = connector(whatnotDocMock(account()));
    expect(c.source).toBe("whatnot");
    expect(c.writes).toBe(WHATNOT_WRITES);
    expect(WHATNOT_WRITES).toEqual([{ integration: "whatnot", name: "cancel_order", description: "Cancel a Whatnot order", kind: "update", approval: "each", dailyCap: 5 }]);
    // A read-only gate turns the write down and audits it, and it never runs.
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    for (const action of c.writes ?? []) {
      await expect(gate.run(action, "whatnot-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    }
    expect(performed).toBe(false);
    expect(audit.entries).toMatchObject([{ action: "cancel_order", integration: "whatnot" }]);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });

  it("turns down a checkpoint that isn't its own", () => {
    const good: WhatnotCursor[] = [
      { done: false, step: "orders", page: null },
      { done: false, step: "orders", page: "abc" },
      { done: false, step: "products", page: "c".repeat(2048) },
      { done: true, step: null, page: null },
    ];
    expect(parseWhatnotCursor(null)).toBeNull();
    for (const c of good) expect(parseWhatnotCursor(JSON.stringify(c))).toEqual(c);
    const bad: unknown[] = [
      "{",
      "null",
      "[]",
      "5",
      {},
      { done: false, step: "orders" },
      { done: false, step: "orders", page: null, extra: 1 },
      { done: "false", step: "orders", page: null },
      { done: false, step: "shows", page: null },
      { done: false, step: null, page: null },
      { done: false, step: "orders", page: "" },
      { done: false, step: "orders", page: "c".repeat(2049) },
      { done: false, step: "orders", page: 5 },
      { done: true, step: "orders", page: null },
      { done: true, step: null, page: "abc" },
      // Another connector's checkpoints.
      { done: false, through: null, pass: null },
      { pass: "historical", step: 0, offset: 0, since: 0, nextSince: 0 },
    ];
    for (const raw of bad) expect(() => parseWhatnotCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Whatnot checkpoint is not in the expected shape");
  });
});

describe("Whatnot doc mock", () => {
  const get = (mock: WhatnotMock, path = "/orders", query = "", headers: Record<string, string> = { authorization: BEARER }) => mock.fetch(`${WHATNOT_API_BASE}${path}${query}`, { headers });
  const body = async (response: Response) => (await response.json()) as { data: { id: string }[]; next_cursor: string | null; type?: string; required_scopes?: string[]; detail?: unknown };

  it("uses only synthetic data, and says where it came from", () => {
    const data = account();
    assertSynthetic([data.orders, data.items, data.products, data.variants]);
    const { mock } = whatnotDocMock(data);
    expect(mock.source).toEqual({ url: WHATNOT_DOC_PAGES.orders, title: "Whatnot Seller API reference: List orders", retrievedOn: "2026-11-11", version: "v2.0.0" });
    expect(mock.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([
      `GET /orders ${WHATNOT_DOC_PAGES.orders}`,
      `GET /orders/{order_id}/items ${WHATNOT_DOC_PAGES.orderItems}`,
      `GET /products ${WHATNOT_DOC_PAGES.products}`,
      `GET /products/{product_id}/variants ${WHATNOT_DOC_PAGES.variants}`,
    ]);
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "whatnot")!;
    expect(module.watchPages).toEqual(Object.values(WHATNOT_DOC_PAGES));
    expect(Object.values(WHATNOT_DOC_PAGES).every((u) => u.startsWith("https://developers.whatnot.com/"))).toBe(true);
  });

  it("checks the token and its scopes", async () => {
    const mock = whatnotDocMock(account({ scopes: ["write:orders"] }));
    const wrong = await get(mock, "/orders", "", { authorization: "Bearer other" });
    expect([wrong.status, (await body(wrong)).type, wrong.headers.get("content-type")]).toEqual([401, "unauthenticated", "application/problem+json"]);
    expect((await get(mock, "/orders", "", {})).status).toBe(401);
    expect((await get(mock)).status).toBe(200);
    const missing = await get(mock, "/products");
    expect([missing.status, (await body(missing)).required_scopes]).toEqual([403, ["read:inventory"]]);
  });

  it("lists, pages and orders as the docs say, newest first by default", async () => {
    reset();
    const mock = whatnotDocMock({ token: TOKEN, orders: whatnotOrder.many(12), items: whatnotOrderItem.many(1), products: whatnotProduct.many(1), variants: whatnotVariant.many(1) });
    const firstPage = await body(await get(mock));
    expect(firstPage.data.map((o) => o.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(123412 - i)));
    const next = await body(await get(mock, "/orders", `?cursor=${firstPage.next_cursor}`));
    expect([next.data.map((o) => o.id), next.next_cursor]).toEqual([["123402", "123401"], null]);
    expect((await body(await get(mock, "/orders", "?reverse=false&limit=2"))).data.map((o) => o.id)).toEqual(["123401", "123402"]);
    expect((await body(await get(mock, "/orders/123401/items"))).data.map((i) => i.id)).toEqual(["987601"]);
    expect((await body(await get(mock, "/orders/123402/items"))).data).toEqual([]);
    expect((await body(await get(mock, "/products/12301/variants?limit=50&reverse=false"))).data.map((v) => v.id)).toEqual(["variant-1"]);
    expect(mock.reads.at(-1)).toEqual({ path: "/products/12301/variants", limit: 50, reverse: false, cursor: null });
  });

  it("answers 422, 404 and 429 as the docs say", async () => {
    const mock = whatnotDocMock(account({ rateLimits: 1 }));
    const limited = await get(mock);
    expect([limited.status, limited.headers.get("retry-after"), (await body(limited)).type]).toEqual([429, "1", "rate-limited"]);
    for (const q of ["?limit=0", "?limit=51", "?limit=1.5", "?reverse=yes", "?cursor=junk", "?updated_since=2026-01-01", `?cursor=${"c".repeat(2049)}`]) {
      const r = await get(mock, "/orders", q);
      expect(r.status, q).toBe(422);
      expect(Array.isArray((await body(r)).detail), q).toBe(true);
    }
    const page = await body(await get(mock, "/orders", "?limit=1"));
    expect((await get(mock, "/products", `?cursor=${page.next_cursor}`)).status).toBe(422);
    expect((await get(mock, "/orders/0123/items")).status).toBe(422);
    const lost = await get(mock, "/orders/999999/items");
    expect([lost.status, (await body(lost)).type]).toEqual([404, "order-not-found"]);
    expect((await body(await get(mock, "/products/nope/variants"))).type).toBe("product-not-found");
  });

  it("throws on a look-alike host and anything the docs don't list", async () => {
    const mock = whatnotDocMock(account());
    await expect(mock.fetch("https://api.whatnot.com.example.test/seller-api/rest/v2/orders", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${WHATNOT_API_BASE}/orders/123401/cancel`, { method: "POST", body: "{}", headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${WHATNOT_API_BASE}/inventory/set`, { method: "POST", body: "{}", headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${WHATNOT_API_BASE}/shows`, { headers: { authorization: BEARER } })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
