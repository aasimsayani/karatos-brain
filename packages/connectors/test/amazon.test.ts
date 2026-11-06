import { beforeEach, describe, expect, it } from "vitest";
import { runSync, writePolicy, InMemoryWriteAuditLog, WriteGate, type SourceBatch } from "@karatos/core";
import {
  TEST_ORG,
  amazonDocMock,
  amazonOrder,
  amazonStock,
  amazonTransaction,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  synthetic,
  testPipeline,
  type AmazonMock,
  type AmazonMockData,
} from "@karatos/connector-testkit";
import {
  AMAZON_EVENTS,
  AMAZON_FBA_LOCATION,
  AMAZON_FIRST_PASS_DAYS,
  AMAZON_HISTORY_DAYS,
  AMAZON_LWA_TOKEN_URL,
  AMAZON_OVERLAP_DAYS,
  AMAZON_SETTLE_MS,
  AMAZON_TRANSACTION_RANGE_DAYS,
  AMAZON_WRITES,
  AmazonApiError,
  AmazonConfigError,
  AmazonShapeError,
  amazonCents,
  amazonClient,
  amazonConnector,
  amazonInventoryParams,
  amazonOrderEvents,
  amazonOrderParams,
  amazonPage,
  amazonStockEvent,
  amazonTime,
  amazonTimeMs,
  amazonTransactionEvent,
  amazonTransactionParams,
  parseAmazonCursor,
  type AmazonBrainEvent,
  type AmazonClientOptions,
  type AmazonConnectorOptions,
  type AmazonCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = `amzn1.application-oa2-client.${"a".repeat(32)}`;
const SECRET = "s".repeat(64);
const REFRESH = `Atzr|${"r".repeat(60)}`;
const NOW_MS = Date.parse("2026-11-03T15:00:00.000Z");
const NOW = () => NOW_MS;
const RECEIVED = "2026-11-03T15:00:00.000Z";
const CTX = { receivedAt: RECEIVED };
const API = "https://sellingpartnerapi-na.amazon.com";
const DAY_MS = 86_400_000;
const HOUR = 3_600_000;
const noSleep = async () => {};
const iso = (ms: number) => new Date(ms).toISOString();
const R = { after: "2026-10-01T00:00:00.000Z", before: "2026-11-01T00:00:00.000Z" };
const BEFORE = iso(NOW_MS - AMAZON_SETTLE_MS);
const EARLIEST = iso(NOW_MS - AMAZON_HISTORY_DAYS * DAY_MS);

/** Six orders and six transactions an hour past 0, 1, 3, 10, 400 and 800 days ago (the last is past the two years read), and three SKUs in stock. */
function account(overrides: Partial<AmazonMockData> = {}): AmazonMockData {
  amazonOrder.reset();
  amazonTransaction.reset();
  amazonStock.reset();
  const when = (ago: number) => iso(NOW_MS - ago * DAY_MS - HOUR);
  const days = [0, 1, 3, 10, 400, 800];
  return {
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    refreshToken: REFRESH,
    orders: days.map((ago) => amazonOrder.one({ createdTime: when(ago), lastUpdatedTime: when(ago) })),
    transactions: days.map((ago) => amazonTransaction.one({ postedDate: when(ago) })),
    stock: amazonStock.many(3),
    now: NOW,
    ...overrides,
  };
}

const base = (fetch?: typeof globalThis.fetch): AmazonClientOptions => ({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH, sleep: noSleep, now: NOW, ...(fetch ? { fetch } : {}) });
const connector = (mock: AmazonMock, overrides: Partial<AmazonConnectorOptions> = {}) => amazonConnector({ ...base(mock.fetch), ...overrides });

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lwaOk = () => json(200, { access_token: `Atza|${"t".repeat(40)}`, token_type: "bearer", expires_in: 3600 });
/** A fetch that answers LWA with a token and SP-API with `answer`, recording every request. */
function scripted(answer: (n: number) => Response) {
  const sent: { method: string; url: string; headers: Headers; body: string }[] = [];
  let n = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(url), headers: new Headers(init?.headers), body: init?.body ? String(init.body) : "" });
    return String(url) === AMAZON_LWA_TOKEN_URL ? lwaOk() : answer(n++);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const ranges = (mock: AmazonMock, path: "/orders" | "/transactions") =>
  mock.reads.filter((r) => r.path === path).map((r) => (path === "/orders" ? `${r.query.get("lastUpdatedAfter")}..${r.query.get("lastUpdatedBefore")}` : `${r.query.get("postedAfter")}..${r.query.get("postedBefore")}`));

describe("Amazon normalizer", () => {
  beforeEach(() => {
    amazonOrder.reset();
    amazonTransaction.reset();
    amazonStock.reset();
  });

  it("reads amounts as whole cents without floating point, and turns down anything that isn't one", () => {
    const cases: [unknown, number | undefined][] = [
      ["49.99", 4999],
      ["-3.5", -350],
      [" 5 ", 500],
      ["0.005", 1],
      ["1.235", 124],
      ["-1.235", -124],
      ["-0.004", 0],
      [84.98, 8498],
      [-15, -1500],
      [0.1 + 0.2, 30],
      ["1e3", undefined],
      ["", undefined],
      ["12.3.4", undefined],
      ["$5", undefined],
      [null, undefined],
      [Number.POSITIVE_INFINITY, undefined],
      [{}, undefined],
    ];
    for (const [value, cents] of cases) expect(amazonCents(value), String(value)).toBe(cents);
    expect(Object.is(amazonCents("-0.004"), 0)).toBe(true);
  });

  it("reads times with a zone, normalized to UTC, and turns down anything else", () => {
    expect(amazonTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(amazonTime("2026-01-02T03:04:05.123456Z")).toBe("2026-01-02T03:04:05.123Z");
    expect(amazonTime("2026-01-02T03:04Z")).toBe("2026-01-02T03:04:00.000Z");
    expect(amazonTime("2026-01-02T03:04:05-05:00")).toBe("2026-01-02T08:04:05.000Z");
    for (const bad of ["2026-01-02", "2026-01-02T03:04:05", "2026-13-02T03:04:05Z", "soon", 1_700_000_000, null]) expect(amazonTime(bad), String(bad)).toBeUndefined();
    expect(amazonTimeMs("2026-01-02T03:04:05Z")).toBe(Date.parse("2026-01-02T03:04:05Z"));
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-02T03:04:05+01:00", "2026-01-02T03:04Z", 5]) expect(amazonTimeMs(bad), String(bad)).toBeNaN();
  });

  it("reads a page of orders, transactions or stock with its token, and throws on a page without the list", () => {
    expect(amazonPage({ orders: [{ orderId: "1" }], pagination: { nextToken: "n1" } }, "orders")).toEqual({ items: [{ orderId: "1" }], next: "n1" });
    expect(amazonPage({ orders: [] }, "orders")).toEqual({ items: [], next: undefined });
    expect(amazonPage({ payload: { transactions: [5], nextToken: "n2" } }, "transactions")).toEqual({ items: [{}], next: "n2" });
    expect(amazonPage({ payload: { inventorySummaries: [], nextToken: "x" }, pagination: { nextToken: "n3" } }, "inventory")).toEqual({ items: [], next: "n3" });
    expect(amazonPage({ payload: { transactions: [] }, pagination: { nextToken: "x" } }, "transactions").next).toBeUndefined();
    expect(amazonPage({ orders: [], pagination: { nextToken: "" } }, "orders").next).toBeUndefined();
    expect(() => amazonPage({ payload: {} }, "orders")).toThrow(new AmazonShapeError("Amazon answered without orders"));
    expect(() => amazonPage({ transactions: [] }, "transactions")).toThrow("Amazon answered without transactions");
    expect(() => amazonPage(null, "inventory")).toThrow("Amazon answered without inventorySummaries");
  });

  it("turns a paid order into order.updated and sale.completed, without the buyer or the address", () => {
    const order = amazonOrder.one();
    const events = amazonOrderEvents(order, CTX);
    expect(events.map((e) => e.type)).toEqual([AMAZON_EVENTS.order, AMAZON_EVENTS.sale]);
    const [updated, sale] = events as [AmazonBrainEvent, AmazonBrainEvent];
    expect(updated).toMatchObject({ occurredAt: order.lastUpdatedTime, receivedAt: RECEIVED, idempotencyKey: `amazon:order:${order.orderId}:${order.lastUpdatedTime}` });
    expect(updated.payload).toEqual({
      orderId: `amazon:order:${order.orderId}`,
      createdAt: order.createdTime,
      status: "SHIPPED",
      fulfilledBy: "AMAZON",
      channel: "amazon",
      marketplaceId: "ATVPDKIKX0DER",
      marketplace: "Amazon.com",
      currency: "USD",
      totalCents: 9998,
      lineCount: 1,
      units: 2,
    });
    expect(sale).toMatchObject({ occurredAt: order.createdTime, idempotencyKey: `amazon:sale:${order.orderId}` });
    expect(sale.payload).toEqual({
      saleId: `amazon:order:${order.orderId}`,
      channel: "online",
      lines: [{ sku: synthetic.sku(1), quantity: 2, unitPriceCents: 4999, discountCents: 0 }],
      totalCents: 9998,
      payments: [{ method: "other", amountCents: 9998 }],
      marketplace: "amazon",
      currency: "USD",
    });
    const kept = JSON.stringify(events);
    for (const personal of [synthetic.name(1), synthetic.email(1), "Test Street", synthetic.phone(1)]) expect(kept).not.toContain(personal);
    expect(updated.id).toMatch(/^amazon_order:[A-Za-z0-9_.:-]+$/);
  });

  it("counts a sale only once it is paid and every line can be read", () => {
    const order = () => amazonOrder.one();
    const sales = (o: Record<string, unknown>) => amazonOrderEvents(o, CTX).filter((e) => e.type === AMAZON_EVENTS.sale);
    for (const status of ["PENDING", "PENDING_AVAILABILITY", "CANCELLED", "UNFULFILLABLE"]) {
      const o = order();
      expect(sales({ ...o, fulfillment: { fulfillmentStatus: status } }), status).toEqual([]);
    }
    for (const status of ["UNSHIPPED", "PARTIALLY_SHIPPED"]) expect(sales({ ...order(), fulfillment: { fulfillmentStatus: status } })).toHaveLength(1);
    const o = order();
    const item = (o.orderItems as Record<string, unknown>[])[0]!;
    const product = item.product as Record<string, unknown>;
    expect(sales({ ...o, fulfillment: {} })).toEqual([]);
    expect(sales({ ...o, proceeds: {} })).toEqual([]);
    expect(sales({ ...o, proceeds: { grandTotal: { amount: "0.00", currencyCode: "USD" } } })).toEqual([]);
    expect(sales({ ...o, orderItems: [] })).toEqual([]);
    expect(sales({ ...o, orderItems: [{ ...item, product: { ...product, price: {} } }] })).toEqual([]);
    expect(sales({ ...o, orderItems: [{ ...item, product: { ...product, price: { unitPrice: { amount: "-1.00" } } } }] })).toEqual([]);
    expect(sales({ ...o, orderItems: [{ ...item, quantityOrdered: 1.5 }] })).toEqual([]);
    expect(sales({ ...o, orderItems: [{ ...item, product: { price: product.price } }] })).toEqual([]);
    // A cancelled line (no units left) is left out of the sale; the rest still counts.
    const both = sales({ ...o, orderItems: [item, { ...item, quantityOrdered: 0, product: { ...product, sellerSku: "GONE" } }] });
    expect((both[0]!.payload.lines as unknown[]).length).toBe(1);
    // A line with no seller SKU goes by its ASIN; one with neither can't be read.
    const asin = sales({ ...o, orderItems: [{ ...item, product: { ...product, sellerSku: " " } }] });
    expect((asin[0]!.payload.lines as { sku: string }[])[0]!.sku).toBe(`amazon:asin:${product.asin}`);
    // Without a currency, the sale says nothing about one.
    expect(sales({ ...o, proceeds: { grandTotal: { amount: "99.98" } } })[0]!.payload).not.toHaveProperty("currency");
  });

  it("keeps what it can read of an order, and skips one without an id", () => {
    expect(amazonOrderEvents({ orderId: "a b" }, CTX)).toEqual([]);
    expect(amazonOrderEvents({}, CTX)).toEqual([]);
    const bare = amazonOrderEvents({ orderId: "111-1" }, CTX);
    expect(bare).toHaveLength(1);
    expect(bare[0]!.payload).toEqual({ orderId: "amazon:order:111-1", status: null, channel: "amazon", totalCents: null, lineCount: 0, units: 0 });
    // Without an update time, it is keyed by what it holds and left undated for the pipeline to dead-letter.
    expect(bare[0]!.occurredAt).toBeUndefined();
    expect(bare[0]!.idempotencyKey).toMatch(/^amazon:order:111-1:[0-9a-f]{16}$/);
    const odd = amazonOrderEvents({ orderId: "111-2", fulfillment: { fulfillmentStatus: "shipped now", fulfilledBy: 5 }, salesChannel: { marketplaceId: "a/b", marketplaceName: "x".repeat(80) }, proceeds: { grandTotal: { amount: "1", currencyCode: "usd" } } }, CTX)[0]!;
    expect(odd.payload).toMatchObject({ status: null, marketplace: "x".repeat(60), totalCents: 100 });
    expect(odd.payload).not.toHaveProperty("fulfilledBy");
    expect(odd.payload).not.toHaveProperty("marketplaceId");
    expect(odd.payload).not.toHaveProperty("currency");
    // Lines with an unreadable quantity count no units.
    expect(amazonOrderEvents({ orderId: "111-3", orderItems: [{ quantityOrdered: -1 }, { quantityOrdered: 3 }] }, CTX)[0]!.payload).toMatchObject({ lineCount: 2, units: 3 });
  });

  it("turns a transaction into marketplace.transaction_posted with its order and breakdown", () => {
    const txn = amazonTransaction.one();
    const e = amazonTransactionEvent(txn, CTX)!;
    expect(e).toMatchObject({ type: AMAZON_EVENTS.transaction, occurredAt: txn.postedDate, idempotencyKey: "amazon:txn:txn-1001:RELEASED" });
    expect(e.payload).toEqual({
      transactionId: "amazon:transaction:txn-1001",
      type: "Shipment",
      status: "RELEASED",
      description: "Order Payment",
      postedAt: txn.postedDate,
      currency: "USD",
      amountCents: 8498,
      orderId: "amazon:order:111-TEST000-0000001",
      groupId: "amazon:group:group-1",
      breakdowns: [
        { type: "Sales", amountCents: 9998 },
        { type: "Expenses", amountCents: -1500 },
      ],
    });
    // Released after being deferred, it is a new version; the same status again is a duplicate.
    expect(amazonTransactionEvent({ ...txn, transactionStatus: "DEFERRED" }, CTX)!.idempotencyKey).toBe("amazon:txn:txn-1001:DEFERRED");
    expect(amazonTransactionEvent({ ...txn }, CTX)!.idempotencyKey).toBe(e.idempotencyKey);
  });

  it("keys a transaction without an id by what it holds, and skips one without a date or amount", () => {
    const txn = amazonTransaction.one();
    const { transactionId, transactionStatus, ...anon } = txn;
    expect([transactionId, transactionStatus]).toBeTruthy();
    const e = amazonTransactionEvent(anon, CTX)!;
    expect(e.idempotencyKey).toMatch(/^amazon:txn:[0-9a-f]{16}$/);
    expect(e.payload).not.toHaveProperty("transactionId");
    expect(e.payload).not.toHaveProperty("status");
    expect(amazonTransactionEvent({ ...anon, description: "Other" }, CTX)!.idempotencyKey).not.toBe(e.idempotencyKey);
    expect(amazonTransactionEvent({ ...txn, transactionId: "a b" }, CTX)!.idempotencyKey).toMatch(/^amazon:txn:[0-9a-f]{16}$/);
    expect(amazonTransactionEvent({ ...txn, transactionStatus: undefined }, CTX)!.idempotencyKey).toBe("amazon:txn:txn-1001:unknown");
    expect(amazonTransactionEvent({ ...txn, postedDate: "yesterday" }, CTX)).toBeNull();
    expect(amazonTransactionEvent({ ...txn, totalAmount: {} }, CTX)).toBeNull();
    expect(amazonTransactionEvent(null as unknown as Record<string, unknown>, CTX)).toBeNull();
    const sparse = amazonTransactionEvent({ postedDate: txn.postedDate, totalAmount: { currencyAmount: "1.00" }, relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "a b" }], breakdowns: [{ breakdownType: "Tax" }, { breakdownAmount: { currencyAmount: 1 } }] }, CTX)!;
    expect(sparse.payload).toEqual({ type: null, postedAt: txn.postedDate, amountCents: 100, breakdowns: [] });
  });

  it("turns stock into inventory.counted, counting what can ship now", () => {
    const stock = amazonStock.one();
    const e = amazonStockEvent(stock, CTX)!;
    expect(e).toMatchObject({ type: AMAZON_EVENTS.stock, occurredAt: stock.lastUpdatedTime });
    expect(e.idempotencyKey).toMatch(new RegExp(`^amazon:count:${synthetic.sku(1)}:2026-01-01:[0-9a-f]{16}$`));
    expect(e.payload).toEqual({ sku: synthetic.sku(1), onHand: 11, locationId: AMAZON_FBA_LOCATION, asin: "B0TEST0001", fnSku: "X00TEST001", condition: "NewItem", totalQuantity: 15, inbound: 2, reserved: 1, unfulfillable: 1 });
    // Without the details, it counts Amazon's total, and dates it when read if Amazon doesn't say.
    const plain = amazonStockEvent({ sellerSku: "SKU-1", totalQuantity: 4 }, CTX)!;
    expect(plain.payload).toEqual({ sku: "SKU-1", onHand: 4, locationId: AMAZON_FBA_LOCATION, totalQuantity: 4 });
    expect(plain.occurredAt).toBe(RECEIVED);
    // A count that isn't a whole number is kept as null, so the inventory schema dead-letters it.
    expect(amazonStockEvent({ sellerSku: "SKU-1", totalQuantity: 2.5 }, CTX)!.payload.onHand).toBeNull();
    expect(amazonStockEvent({ sellerSku: "SKU-1", inventoryDetails: { inboundShippedQuantity: 3 } }, CTX)!.payload.inbound).toBe(3);
    // A changed count on the same day is a new version.
    expect(amazonStockEvent({ ...stock, inventoryDetails: { fulfillableQuantity: 1 } }, CTX)!.idempotencyKey).not.toBe(e.idempotencyKey);
    for (const sku of [undefined, "", " ", "x".repeat(101), "a\nb"]) expect(amazonStockEvent({ sellerSku: sku, totalQuantity: 1 }, CTX), String(sku)).toBeNull();
    expect(amazonStockEvent({ sellerSku: " SKU-2 " }, CTX)!.payload.sku).toBe("SKU-2");
  });

  it("dates a sale when it was placed, finds the order among other identifiers, and keeps descriptions and SKUs short and printable", () => {
    const placed = amazonOrder.one({ createdTime: "2026-10-01T10:00:00.000Z", lastUpdatedTime: "2026-10-02T12:00:00.000Z" });
    const [updated, sale] = amazonOrderEvents(placed, CTX) as [AmazonBrainEvent, AmazonBrainEvent];
    expect([updated.occurredAt, sale.occurredAt]).toEqual(["2026-10-02T12:00:00.000Z", "2026-10-01T10:00:00.000Z"]);
    const txn = amazonTransaction.one();
    const others = amazonTransactionEvent({ ...txn, relatedIdentifiers: [{ relatedIdentifierName: "SHIPMENT_ID", relatedIdentifierValue: "ship-1" }, ...(txn.relatedIdentifiers as unknown[])] }, CTX)!;
    expect(others.payload.orderId).toBe("amazon:order:111-TEST000-0000001");
    expect(amazonTransactionEvent({ ...txn, description: "d".repeat(300) }, CTX)!.payload.description).toBe("d".repeat(200));
    for (const sku of ["a\tb", "caf\u00e9"]) expect(amazonStockEvent({ sellerSku: sku, totalQuantity: 1 }, CTX), sku).toBeNull();
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic([amazonOrder.many(3), amazonTransaction.many(3), amazonStock.many(3)]);
  });
});

describe("Amazon client", () => {
  it("builds queries only from a checked range, the fixed data asked for and Amazon's own token", () => {
    expect(Object.fromEntries(amazonOrderParams("ATVPDKIKX0DER", R, null))).toEqual({ marketplaceIds: "ATVPDKIKX0DER", lastUpdatedAfter: R.after, lastUpdatedBefore: R.before, maxResultsPerPage: "100", includedData: "PROCEEDS,FULFILLMENT" });
    expect(amazonOrderParams("ATVPDKIKX0DER", R, "t1").get("paginationToken")).toBe("t1");
    expect(Object.fromEntries(amazonTransactionParams("ATVPDKIKX0DER", R, "t2"))).toEqual({ postedAfter: R.after, postedBefore: R.before, marketplaceId: "ATVPDKIKX0DER", nextToken: "t2" });
    expect(Object.fromEntries(amazonInventoryParams("ATVPDKIKX0DER", null))).toEqual({ details: "true", granularityType: "Marketplace", granularityId: "ATVPDKIKX0DER", marketplaceIds: "ATVPDKIKX0DER" });
    expect(amazonInventoryParams("ATVPDKIKX0DER", "t3").get("nextToken")).toBe("t3");
    const wide = { after: R.after, before: iso(Date.parse(R.after) + AMAZON_TRANSACTION_RANGE_DAYS * DAY_MS) };
    expect(amazonTransactionParams("M", wide, null).get("postedBefore")).toBe(wide.before);
    expect(() => amazonTransactionParams("M", { ...wide, before: iso(Date.parse(wide.before) + 1) }, null)).toThrow(new AmazonConfigError("a range can't be wider than 179 days"));
    // Orders take any width.
    expect(amazonOrderParams("M", { after: EARLIEST, before: BEFORE }, null).get("lastUpdatedAfter")).toBe(EARLIEST);
    for (const bad of [{ after: R.before, before: R.before }, { after: R.before, before: R.after }]) expect(() => amazonOrderParams("M", bad, null)).toThrow("before must be later than after");
    for (const bad of [{ after: "2026-10-01", before: R.before }, { after: R.after, before: "soon" }]) expect(() => amazonOrderParams("M", bad, null)).toThrow("after and before must be ISO times in UTC");
    expect(() => amazonOrderParams("M", { ...R, orderStatuses: "x" } as never, null)).toThrow("a range doesn't take orderStatuses");
    for (const t of ["", "a b", "x".repeat(4097), 5 as unknown as string]) {
      expect(() => amazonInventoryParams("M", t), String(t)).toThrow("the page token must be the one Amazon returned");
      expect(() => amazonTransactionParams("M", R, t)).toThrow("the page token must be the one Amazon returned");
      expect(() => amazonOrderParams("M", R, t)).toThrow("the page token must be the one Amazon returned");
    }
  });

  it("won't build without its credentials, or with a bad marketplace, region or environment", () => {
    const build = (o: Partial<AmazonClientOptions>) => () => amazonClient({ ...base(), ...o });
    expect(build({ clientId: "amzn1.application-oa2-client.short" })).toThrow("AMAZON_SP_CLIENT_ID must be the app's LWA client id");
    expect(build({ clientId: "" })).toThrow(AmazonConfigError);
    expect(build({ clientSecret: "short" })).toThrow("set AMAZON_SP_CLIENT_SECRET");
    expect(build({ clientSecret: undefined as unknown as string })).toThrow("set AMAZON_SP_CLIENT_SECRET");
    expect(build({ refreshToken: "has a space in it, so no" })).toThrow("set AMAZON_SP_REFRESH_TOKEN");
    expect(build({ marketplaceId: "us" })).toThrow("AMAZON_SP_MARKETPLACE_ID must be a marketplace id");
    expect(build({ region: "us" })).toThrow("AMAZON_SP_REGION must be na, eu or fe");
    expect(build({ region: "toString" })).toThrow("AMAZON_SP_REGION must be na, eu or fe");
    expect(build({ environment: "staging" })).toThrow("AMAZON_SP_ENVIRONMENT must be production or sandbox");
    expect(build({ environment: "constructor" })).toThrow("AMAZON_SP_ENVIRONMENT must be production or sandbox");
    expect(build({ clientId: ` ${CLIENT_ID} `, marketplaceId: " ", region: "", environment: " " })().marketplaceId).toBe("ATVPDKIKX0DER");
  });

  it("reaches the region and environment it was given", async () => {
    for (const [region, environment, host] of [
      ["eu", "production", "https://sellingpartnerapi-eu.amazon.com"],
      ["fe", "sandbox", "https://sandbox.sellingpartnerapi-fe.amazon.com"],
      [undefined, "sandbox", "https://sandbox.sellingpartnerapi-na.amazon.com"],
    ] as const) {
      const { fetch, sent } = scripted(() => json(200, { payload: { inventorySummaries: [] } }));
      await amazonClient({ ...base(fetch), region, environment, marketplaceId: "A1PA6795UKMFR9" }).inventory(null);
      expect(sent.at(-1)!.url).toBe(`${host}/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=A1PA6795UKMFR9&marketplaceIds=A1PA6795UKMFR9`);
    }
  });

  it("refreshes through LWA with a form, then sends only GETs with the access token in a header, never in the URL", async () => {
    const mock = amazonDocMock(account());
    const client = amazonClient(base(mock.fetch));
    await client.orders(R, null);
    await client.transactions(R, null);
    await client.inventory(null);
    expect(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      `POST ${AMAZON_LWA_TOKEN_URL}`,
      `GET ${API}/orders/2026-01-01/orders`,
      `GET ${API}/finances/2024-06-19/transactions`,
      `GET ${API}/fba/inventory/v1/summaries`,
    ]);
    // One access token serves every request while it lasts.
    expect(mock.refreshes).toBe(1);
    for (const c of mock.fetch.calls) for (const secret of [SECRET, REFRESH, "Atza|"]) expect(c.url).not.toContain(secret);
    const { fetch, sent } = scripted(() => json(200, { orders: [] }));
    await amazonClient(base(fetch)).orders(R, null);
    expect(sent[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET });
    expect(sent[1]!.method).toBe("GET");
    expect(sent[1]!.headers.get("x-amz-access-token")).toBe(`Atza|${"t".repeat(40)}`);
    expect(sent[1]!.headers.get("user-agent")).toMatch(/^KaratOS\/1\.0 \(Language=TypeScript\)$/);
    expect(sent[1]!.headers.get("authorization")).toBeNull();
  });

  it("renews the access token a minute before it expires, and once when Amazon says it has", async () => {
    let clock = NOW_MS;
    const mock = amazonDocMock(account({ now: () => clock }));
    const client = amazonClient({ ...base(mock.fetch), now: () => clock });
    await client.inventory(null);
    clock += HOUR - 61_000;
    await client.inventory(null);
    expect(mock.refreshes).toBe(1);
    clock += 2_000;
    await client.inventory(null);
    expect(mock.refreshes).toBe(2);
    mock.expireAccessTokens();
    await client.inventory(null);
    expect(mock.refreshes).toBe(3);
    // An LWA answer without expires_in lasts an hour.
    const { fetch } = scripted(() => json(200, { payload: { inventorySummaries: [] } }));
    let lwa = 0;
    const counting = (async (url: string | URL, init?: RequestInit) => (String(url) === AMAZON_LWA_TOKEN_URL ? (lwa++, json(200, { access_token: `Atza|${"u".repeat(40)}` })) : fetch(url, init))) as typeof globalThis.fetch;
    const c2 = amazonClient({ ...base(counting), now: () => clock });
    await c2.inventory(null);
    clock += HOUR - 61_000;
    await c2.inventory(null);
    expect(lwa).toBe(1);
  });

  it("renews once on a 401 or an expired token, and explains a missing role without renewing again", async () => {
    const expired = () => json(403, { errors: [{ code: "Unauthorized", message: "The access token you provided has expired." }] });
    const once = scripted((n) => (n === 0 ? expired() : json(200, { orders: [] })));
    await amazonClient(base(once.fetch)).orders(R, null);
    expect(once.sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    const twice = scripted(() => expired());
    await expect(amazonClient(base(twice.fetch)).orders(R, null)).rejects.toThrow("Amazon answered HTTP 403: The access token you provided has expired.; give the SP-API app the Finance and Accounting, and Amazon Fulfillment, roles, and re-authorize it");
    expect(twice.sent.filter((s) => s.method === "POST")).toHaveLength(2);
    const unauthenticated = scripted((n) => (n === 0 ? json(401, {}) : json(200, { orders: [] })));
    await amazonClient(base(unauthenticated.fetch)).orders(R, null);
    expect(unauthenticated.sent.filter((s) => s.method === "POST")).toHaveLength(2);
    const mock = amazonDocMock(account({ roles: ["orders", "finance"] }));
    const error = await amazonClient(base(mock.fetch)).inventory(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonApiError);
    expect(error).toMatchObject({ status: 403, code: "Unauthorized", message: expect.stringContaining("Access to requested resource is denied.; give the SP-API app") });
    expect(mock.refreshes).toBe(1);
    // A 403 for another reason, or with another code, is not renewed either.
    for (const body of [{ errors: [{ code: "Forbidden", message: "expired" }] }, { errors: [{ code: "Unauthorized", message: "denied" }] }]) {
      const s = scripted(() => json(403, body));
      await expect(amazonClient(base(s.fetch)).orders(R, null)).rejects.toThrow(AmazonApiError);
      expect(s.sent.filter((x) => x.method === "POST")).toHaveLength(1);
    }
  });

  it("explains an LWA refusal by its code alone, never repeating the credentials", async () => {
    const lwa = (status: number, body: unknown) => (async (url: string | URL) => (String(url) === AMAZON_LWA_TOKEN_URL ? json(status, body) : json(200, {}))) as typeof globalThis.fetch;
    const leaky = `The request has an invalid grant parameter : ${REFRESH}`;
    const grant = await amazonClient(base(lwa(400, { error: "invalid_grant", error_description: leaky }))).orders(R, null).catch((e: Error) => e);
    expect(grant).toMatchObject({ status: 400, code: "invalid_grant" });
    expect((grant as Error).message).toBe("Login with Amazon turned down the refresh (HTTP 400 invalid_grant); the seller may have removed the app's authorization, so authorize it again and update AMAZON_SP_REFRESH_TOKEN");
    expect((grant as Error).message).not.toContain(REFRESH);
    await expect(amazonClient(base(lwa(401, { error: "invalid_client" }))).orders(R, null)).rejects.toThrow("(HTTP 401 invalid_client); check AMAZON_SP_CLIENT_ID and AMAZON_SP_CLIENT_SECRET");
    await expect(amazonClient(base(lwa(500, "nope"))).orders(R, null)).rejects.toThrow(/^Login with Amazon turned down the refresh \(HTTP 500\)$/);
    await expect(amazonClient(base(lwa(400, { error: "bad code!" }))).orders(R, null)).rejects.toThrow(/^Login with Amazon turned down the refresh \(HTTP 400\)$/);
    for (const body of [{}, { access_token: "short" }, { access_token: `Atza|${"t".repeat(40)}`, token_type: "mac" }]) {
      await expect(amazonClient(base(lwa(200, body))).orders(R, null), JSON.stringify(body)).rejects.toThrow("Login with Amazon did not answer with an access token");
    }
    const mock = amazonDocMock(account({ refreshToken: "Atzr|other-token-entirely" }));
    await expect(amazonClient(base(mock.fetch)).orders(R, null)).rejects.toThrow("invalid_grant");
  });

  it("waits out a 429, 500 or 503 a few times, doubling to a cap, then gives up with a clear error", async () => {
    for (const status of [429, 500, 503]) {
      const waits: number[] = [];
      const s = scripted(() => json(status, { errors: [{ code: "QuotaExceeded", message: "slow down" }] }));
      const error = await amazonClient({ ...base(s.fetch), sleep: async (ms) => void waits.push(ms), retries: 8 }).orders(R, null).catch((e: unknown) => e);
      expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 64000]);
      expect(error).toMatchObject({ status, code: "QuotaExceeded" });
      expect((error as Error).message).toBe(`${status === 429 ? "Amazon kept throttling the sync; its request quota refills over a few minutes" : `Amazon kept answering HTTP ${status}`}, and the next sync resumes from the checkpoint`);
    }
    const mock = amazonDocMock(account({ throttled: 2 }));
    const waits: number[] = [];
    await amazonClient({ ...base(mock.fetch), sleep: async (ms) => void waits.push(ms) }).orders(R, null);
    expect(waits).toEqual([1000, 2000]);
    const three = scripted((n) => (n < 3 ? json(429, {}) : json(200, { orders: [] })));
    await amazonClient(base(three.fetch)).orders(R, null);
    expect(three.sent.filter((x) => x.method === "GET")).toHaveLength(4);
    const four = scripted(() => json(429, {}));
    await expect(amazonClient(base(four.fetch)).orders(R, null)).rejects.toThrow("throttling");
    expect(four.sent.filter((x) => x.method === "GET")).toHaveLength(4);
  });

  it("explains other errors, with Amazon's message cut short, and turns down an answer that isn't JSON", async () => {
    const answer = (r: Response) => amazonClient(base(scripted(() => r).fetch)).orders(R, null);
    await expect(answer(json(404, { errors: [{ code: "NotFound", message: "Resource not found" }] }))).rejects.toThrow("Amazon answered HTTP 404: Resource not found; check AMAZON_SP_REGION matches the marketplace");
    await expect(answer(json(400, { errors: [{ code: "InvalidInput", message: "m".repeat(300) }] }))).rejects.toThrow(new AmazonApiError(`Amazon answered HTTP 400: ${"m".repeat(200)}`, 400, "InvalidInput"));
    await expect(answer(json(400, {}))).rejects.toThrow(/^Amazon answered HTTP 400$/);
    await expect(answer(new Response("<html>", { status: 200 }))).rejects.toThrow("Amazon did not answer with JSON");
    await expect(answer(json(200, [1]))).rejects.toThrow("Amazon did not answer with JSON");
    await expect(answer(json(400, { error_description: 5 }))).rejects.toThrow(/^Amazon answered HTTP 400$/);
    const odd = await answer(json(400, { errors: [{ code: 7, message: 8 }] })).catch((e: AmazonApiError) => e);
    expect([odd.code, odd.message]).toEqual([undefined, "Amazon answered HTTP 400"]);
  });

  it("checks a query before any request is sent", async () => {
    const s = scripted(() => json(200, {}));
    const client = amazonClient(base(s.fetch));
    await expect(client.transactions({ after: EARLIEST, before: BEFORE }, null)).rejects.toThrow("a range can't be wider than 179 days");
    await expect(client.orders({ after: "x", before: BEFORE }, null)).rejects.toThrow(AmazonConfigError);
    await expect(client.inventory("a b")).rejects.toThrow(AmazonConfigError);
    expect(s.sent).toEqual([]);
  });
});

describe("Amazon connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(amazonDocMock(account())), expected: { ingested: 5 * 2 + 5 + 3 } });
    expect(result.full.batches).toBe(7);
    expect(parseAmazonCursor(result.full.cursor)).toEqual({ pass: "historical", step: "done", token: null, after: EARLIEST, before: BEFORE, window: EARLIEST });
  });

  it("reads two years of orders, then the transactions in 179-day steps, then the stock", async () => {
    const mock = amazonDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(18);
    expect(mock.reads.map((r) => r.path)).toEqual(["/orders", "/transactions", "/transactions", "/transactions", "/transactions", "/transactions", "/inventory"]);
    expect(ranges(mock, "/orders")).toEqual([`${EARLIEST}..${BEFORE}`]);
    const steps = ranges(mock, "/transactions").map((r) => r.split("..").map(Date.parse) as [number, number]);
    expect(steps[0]![0]).toBe(Date.parse(EARLIEST));
    expect(steps.at(-1)![1]).toBe(Date.parse(BEFORE));
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i]![1] - steps[i]![0]).toBeLessThanOrEqual(AMAZON_TRANSACTION_RANGE_DAYS * DAY_MS);
      if (i) expect(steps[i]![0]).toBe(steps[i - 1]![1]);
    }
    const count = (type: string) => memory.events.filter((e) => e.type === type).length;
    expect([count(AMAZON_EVENTS.order), count(AMAZON_EVENTS.sale), count(AMAZON_EVENTS.transaction), count(AMAZON_EVENTS.stock)]).toEqual([5, 5, 5, 3]);
    expect(memory.events.every((e) => e.source === "amazon")).toBe(true);
    expect([AMAZON_HISTORY_DAYS, AMAZON_TRANSACTION_RANGE_DAYS, AMAZON_SETTLE_MS]).toEqual([731, 179, 300_000]);
  });

  it("pages through orders, transactions and stock with Amazon's tokens", async () => {
    const mock = amazonDocMock(account({ pageCap: 2 }));
    const batches = await drain(connector(mock, { now: NOW }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    // The last week holds three orders (two events each) and three transactions.
    expect(mock.reads.map((r) => `${r.path}:${r.query.has("paginationToken") || r.query.has("nextToken")}`)).toEqual([
      "/orders:false",
      "/orders:true",
      "/transactions:false",
      "/transactions:true",
      "/inventory:false",
      "/inventory:true",
    ]);
    expect(batches.map((b) => b.events.length)).toEqual([4, 2, 2, 1, 2, 1]);
    expect(parseAmazonCursor(batches[0]!.cursor)).toMatchObject({ step: "orders", token: expect.any(String) });
    expect(parseAmazonCursor(batches[1]!.cursor)).toMatchObject({ step: "transactions", token: null });
    expect(parseAmazonCursor(batches[3]!.cursor)).toMatchObject({ step: "inventory", token: null });
    expect(parseAmazonCursor(batches[5]!.cursor)).toMatchObject({ step: "done", token: null });
  });

  it("follows on from the last pass two days early, storing a changed order as a new version", async () => {
    const data = account();
    const mock = amazonDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // runSync keeps a checkpoint per mode, so the first incremental pass reads the last week, and the next follows on from it.
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    mock.reads.length = 0;
    const later = NOW_MS + DAY_MS;
    data.now = () => later;
    // Amazon ships the newest order again and updates it.
    data.orders[0] = { ...data.orders[0]!, lastUpdatedTime: iso(later - HOUR), fulfillment: { fulfillmentStatus: "SHIPPED", fulfilledBy: "AMAZON" } };
    const report = await runSync({ connector: connector(mock, { now: () => later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const after = iso(Date.parse(BEFORE) - AMAZON_OVERLAP_DAYS * DAY_MS);
    expect(ranges(mock, "/orders")).toEqual([`${after}..${iso(later - AMAZON_SETTLE_MS)}`]);
    expect(ranges(mock, "/transactions")).toEqual([`${after}..${iso(later - AMAZON_SETTLE_MS)}`]);
    // The updated order is new; the other order in the overlap, both sales, the two transactions and the three counts are duplicates.
    expect([report.ingested, report.duplicates]).toEqual([1, 1 + 2 + 2 + 3]);
    expect(AMAZON_OVERLAP_DAYS).toBe(2);
  });

  it("reads the last week on an incremental pass with nothing to follow, and never more than two years", async () => {
    const mock = amazonDocMock(account());
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(ranges(mock, "/orders")).toEqual([`${iso(NOW_MS - AMAZON_FIRST_PASS_DAYS * DAY_MS)}..${BEFORE}`]);
    expect(AMAZON_FIRST_PASS_DAYS).toBe(7);
    mock.reads.length = 0;
    const old: AmazonCursor = { pass: "incremental", step: "done", token: null, after: "2020-01-01T00:00:00.000Z", before: "2020-01-08T00:00:00.000Z", window: "2020-01-01T00:00:00.000Z" };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(old) }));
    expect(ranges(mock, "/orders")).toEqual([`${EARLIEST}..${BEFORE}`]);
    expect(ranges(mock, "/transactions")).toHaveLength(5);
    mock.reads.length = 0;
    // An unfinished import's checkpoint doesn't carry into an incremental pass.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...old, pass: "historical", step: "orders" }) }));
    expect(ranges(mock, "/orders")).toEqual([`${iso(NOW_MS - 7 * DAY_MS)}..${BEFORE}`]);
    mock.reads.length = 0;
    // A pass that ended "after" now (a clock moved back) starts a minute before this pass ends.
    const ahead = { ...old, after: iso(NOW_MS), before: iso(NOW_MS + 30 * DAY_MS), window: iso(NOW_MS) };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ahead) }));
    expect(ranges(mock, "/orders")).toEqual([`${iso(Date.parse(BEFORE) - 60_000)}..${BEFORE}`]);
  });

  it("resumes an unfinished pass from its step, window and token, and keeps a finished import finished", async () => {
    const mock = amazonDocMock(account({ pageCap: 2 }));
    const first = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const mid = parseAmazonCursor(first[0]!.cursor)!;
    mock.reads.length = 0;
    const rest = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(mock.reads[0]!.query.get("paginationToken")).toBe(mid.token);
    expect(rest.length).toBe(first.length - 1);
    // A transactions checkpoint resumes at its window.
    const inTxn = first.map((b) => parseAmazonCursor(b.cursor)!).find((c) => c.step === "transactions" && c.window !== c.after)!;
    mock.reads.length = 0;
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(inTxn) }));
    expect(mock.reads[0]!.query.get("postedAfter")).toBe(inTxn.window);
    expect(mock.reads.some((r) => r.path === "/orders")).toBe(false);
    mock.reads.length = 0;
    const done: AmazonCursor = { pass: "historical", step: "done", token: null, after: EARLIEST, before: BEFORE, window: EARLIEST };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.reads).toEqual([]);
  });

  it("stamps each event with the time it was read, and starts transactions where the pass starts", async () => {
    const mock = amazonDocMock(account());
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(batches.flatMap((b) => b.events as AmazonBrainEvent[]).every((e) => e.receivedAt === RECEIVED)).toBe(true);
    // An orders checkpoint whose window has moved still reads transactions from the start of the pass.
    const after = iso(NOW_MS - 3 * DAY_MS);
    const moved: AmazonCursor = { pass: "incremental", step: "orders", token: null, after, before: BEFORE, window: iso(NOW_MS - DAY_MS) };
    mock.reads.length = 0;
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(moved) }));
    expect(ranges(mock, "/transactions")).toEqual([`${after}..${BEFORE}`]);
  });

  it("starts a stock step that was cut off from its first page, since a stock token lasts only 30 seconds", async () => {
    let clock = NOW_MS;
    const mock = amazonDocMock(account({ pageCap: 2, now: () => clock }));
    const batches = await drain(connector(mock, { now: () => clock }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const cut = parseAmazonCursor(batches.at(-2)!.cursor)!;
    expect(cut).toMatchObject({ step: "inventory", token: expect.any(String) });
    clock += 60_000;
    mock.reads.length = 0;
    const again = await drain(connector(mock, { now: () => clock }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(cut) }));
    expect(mock.reads.map((r) => `${r.path}:${r.query.has("nextToken")}`)).toEqual(["/inventory:false", "/inventory:true"]);
    expect(again.map((b) => b.events.length)).toEqual([2, 1]);
    // Amazon would have turned the old token down.
    await expect(amazonClient({ ...base(mock.fetch), now: () => clock }).inventory(cut.token)).rejects.toThrow("The nextToken has expired.");
  });

  it("dead-letters what the pipeline can't store and stores the rest", async () => {
    const client = {
      marketplaceId: "ATVPDKIKX0DER",
      orders: async () => ({ orders: [{ orderId: "111-1", lastUpdatedTime: "2026-11-01T00:00:00Z" }, { orderId: "111-2" }, { orderId: "a b" }] }),
      transactions: async () => ({ payload: { transactions: [{ postedDate: "2026-11-01T00:00:00Z", totalAmount: { currencyAmount: 1 } }, { postedDate: "never" }] } }),
      inventory: async () => ({ payload: { inventorySummaries: [{ sellerSku: "SKU-1", totalQuantity: 1 }, {}] } }),
    };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(amazonDocMock(account()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // The order with no update time is dead-lettered; records with no id, date, amount or SKU are skipped.
    expect([report.ingested, report.deadLettered]).toEqual([3, 1]);
    expect((memory.events as unknown as AmazonBrainEvent[]).map((e) => e.type).sort()).toEqual([AMAZON_EVENTS.stock, AMAZON_EVENTS.transaction, AMAZON_EVENTS.order].sort());
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseAmazonCursor(null)).toBeNull();
    const ok: AmazonCursor = { pass: "historical", step: "transactions", token: "t1", after: EARLIEST, before: BEFORE, window: iso(Date.parse(EARLIEST) + DAY_MS) };
    expect(parseAmazonCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parseAmazonCursor(JSON.stringify({ ...ok, step: "orders", token: null, window: EARLIEST }))!.step).toBe("orders");
    expect(parseAmazonCursor(JSON.stringify({ ...ok, step: "inventory" }))!.step).toBe("inventory");
    const bad: unknown[] = [
      null,
      {},
      { ...ok, pass: "full" },
      { ...ok, step: "listings" },
      { ...ok, token: 5 },
      { ...ok, token: undefined },
      { ...ok, step: "done" },
      { ...ok, after: "2026-02-30T00:00:00Z" },
      { ...ok, before: "soon" },
      { ...ok, window: "soon" },
      { ...ok, after: BEFORE },
      { ...ok, window: iso(Date.parse(EARLIEST) - 1) },
      { ...ok, window: BEFORE },
    ];
    for (const c of bad) expect(() => parseAmazonCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("Amazon checkpoint is not in the expected shape");
  });

  it("declares changing a listing's quantity and price, needing approval, and a read-only gate turns both down", async () => {
    const c = connector(amazonDocMock(account()));
    expect(c.source).toBe("amazon");
    expect(c.writes).toBe(AMAZON_WRITES);
    expect(AMAZON_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["update_listing_quantity", "update", "each", 20],
      ["update_listing_price", "update", "each", 10],
    ]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["amazon", "update_listing_quantity", "refused"],
      ["amazon", "update_listing_price", "refused"],
    ]);
  });

  it("lets a write through only where the instance turned it on, by name", async () => {
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["amazon:update_listing_price"]), audit });
    const ran: string[] = [];
    for (const action of AMAZON_WRITES) await gate.run(action, "test", async () => void ran.push(action.name)).catch(() => {});
    expect(ran).toEqual(["update_listing_price"]);
    expect(audit.entries.map((a) => a.outcome)).toEqual(["refused", "performed"]);
  });

  it("never asks Amazon for anything but its three lists with the fixed parameters, and never for the buyer", async () => {
    const mock = amazonDocMock(account({ pageCap: 2 }));
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`))).toEqual(
      new Set([`POST ${AMAZON_LWA_TOKEN_URL}`, `GET ${API}/orders/2026-01-01/orders`, `GET ${API}/finances/2024-06-19/transactions`, `GET ${API}/fba/inventory/v1/summaries`]),
    );
    const expected: Record<string, string[]> = {
      "/orders": ["includedData", "lastUpdatedAfter", "lastUpdatedBefore", "marketplaceIds", "maxResultsPerPage"],
      "/transactions": ["marketplaceId", "postedAfter", "postedBefore"],
      "/inventory": ["details", "granularityId", "granularityType", "marketplaceIds"],
    };
    for (const r of mock.reads) {
      expect([...r.query.keys()].filter((k) => k !== "paginationToken" && k !== "nextToken").sort()).toEqual(expected[r.path]);
      if (r.path === "/orders") expect(r.query.get("includedData")).toBe("PROCEEDS,FULFILLMENT");
    }
  });
});

describe("the Amazon mock", () => {
  it("turns down a missing user-agent or token, a bad range, page size, marketplace or data asked for, and a token from another query", async () => {
    let clock = NOW_MS;
    const mock = amazonDocMock(account({ pageCap: 1, now: () => clock }));
    const client = amazonClient({ ...base(mock.fetch), now: () => clock });
    const orderToken = ((await client.orders(R, null)) as { pagination: { nextToken: string } }).pagination.nextToken;
    const access = await mock.fetch(AMAZON_LWA_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET }) }).then((r) => r.json() as Promise<{ access_token: string }>);
    const headers = { "x-amz-access-token": access.access_token, "user-agent": "test/1.0" };
    const get = (path: string, query: string, h: Record<string, string> = headers) => mock.fetch(`${API}${path}?${query}`, { headers: h }).then((r) => r.status);
    const orders = (q: string) => get("/orders/2026-01-01/orders", q);
    const ok = `marketplaceIds=ATVPDKIKX0DER&lastUpdatedAfter=${R.after}&lastUpdatedBefore=${R.before}`;
    expect(await orders(ok)).toBe(200);
    expect(await orders(`marketplaceIds=ATVPDKIKX0DER&createdAfter=${R.after}`)).toBe(200);
    expect(await get("/orders/2026-01-01/orders", ok, { "x-amz-access-token": access.access_token })).toBe(400);
    expect(await get("/orders/2026-01-01/orders", ok, { "user-agent": "test/1.0" })).toBe(403);
    expect(await orders(`${ok}&createdAfter=${R.after}`)).toBe(400);
    expect(await orders(`marketplaceIds=ATVPDKIKX0DER&lastUpdatedBefore=${R.before}`)).toBe(400);
    expect(await orders(`marketplaceIds=ATVPDKIKX0DER&lastUpdatedAfter=2026-10-01`)).toBe(400);
    expect(await orders(`marketplaceIds=ATVPDKIKX0DER&lastUpdatedAfter=${R.after}&lastUpdatedBefore=${iso(NOW_MS - 60_000)}`)).toBe(400);
    expect(await orders(`marketplaceIds=ATVPDKIKX0DER&lastUpdatedAfter=${R.before}&lastUpdatedBefore=${R.after}`)).toBe(400);
    expect(await orders(`lastUpdatedAfter=${R.after}`)).toBe(400);
    expect(await orders(`marketplaceIds=A1PA6795UKMFR9&lastUpdatedAfter=${R.after}`)).toBe(400);
    expect(await orders(`${ok}&maxResultsPerPage=101`)).toBe(400);
    expect(await orders(`${ok}&includedData=EVERYTHING`)).toBe(400);
    const paged = amazonOrderParams("ATVPDKIKX0DER", R, orderToken);
    expect(await orders(String(paged))).toBe(200);
    paged.set("maxResultsPerPage", "5");
    expect(await orders(String(paged))).toBe(400);
    // The buyer and address come back only when asked for.
    const withBuyer = await mock.fetch(`${API}/orders/2026-01-01/orders?${ok}&includedData=BUYER`, { headers }).then((r) => r.json() as Promise<{ orders: Record<string, unknown>[] }>);
    expect(withBuyer.orders[0]).toHaveProperty("buyer");
    expect(withBuyer.orders[0]).not.toHaveProperty("proceeds");
    const txns = (q: string) => get("/finances/2024-06-19/transactions", q);
    expect(await txns(`postedAfter=${R.after}&postedBefore=${R.before}`)).toBe(200);
    expect(await txns(`postedBefore=${R.before}`)).toBe(400);
    expect(await txns(`postedAfter=${R.after}&postedBefore=${R.after}`)).toBe(400);
    expect(await txns(`postedAfter=${R.after}&postedBefore=${iso(NOW_MS)}`)).toBe(400);
    expect(await txns(`postedAfter=${R.after}&marketplaceId=A1PA6795UKMFR9`)).toBe(400);
    expect(await txns(`postedAfter=${R.after}&nextToken=${orderToken}`)).toBe(400);
    // Wider than 180 days, Amazon answers with no transactions rather than an error.
    const wide = await mock.fetch(`${API}/finances/2024-06-19/transactions?postedAfter=${EARLIEST}&postedBefore=${BEFORE}`, { headers }).then((r) => r.json() as Promise<{ payload: { transactions: unknown[] } }>);
    expect(wide.payload.transactions).toEqual([]);
    const stock = (q: string) => get("/fba/inventory/v1/summaries", q);
    const m = "ATVPDKIKX0DER";
    expect(await stock(`granularityType=Marketplace&granularityId=${m}&marketplaceIds=${m}`)).toBe(200);
    expect(await stock(`granularityType=Store&granularityId=${m}&marketplaceIds=${m}`)).toBe(400);
    expect(await stock(`granularityType=Marketplace&marketplaceIds=${m}`)).toBe(400);
    expect(await stock(`granularityType=Marketplace&granularityId=${m}&marketplaceIds=${m},A1PA6795UKMFR9`)).toBe(400);
    expect(await stock(`granularityType=Marketplace&granularityId=A1PA6795UKMFR9&marketplaceIds=A1PA6795UKMFR9`)).toBe(400);
    const plain = await mock.fetch(`${API}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${m}&marketplaceIds=${m}`, { headers }).then((r) => r.json() as Promise<{ payload: { inventorySummaries: Record<string, unknown>[] } }>);
    expect(plain.payload.inventorySummaries[0]).not.toHaveProperty("inventoryDetails");
    // An order token lasts a day.
    clock += DAY_MS + 1;
    await expect(amazonClient({ ...base(mock.fetch), now: () => clock }).orders(R, orderToken)).rejects.toThrow("The paginationToken has expired.");
    // LWA wants a form, a refresh grant and the app's own client.
    const lwa = (body: Record<string, string>, type = "application/x-www-form-urlencoded") => mock.fetch(AMAZON_LWA_TOKEN_URL, { method: "POST", headers: { "content-type": type }, body: new URLSearchParams(body) }).then((r) => r.status);
    const form = { grant_type: "refresh_token", refresh_token: REFRESH, client_id: CLIENT_ID, client_secret: SECRET };
    expect(await lwa(form)).toBe(200);
    expect(await lwa(form, "application/json")).toBe(400);
    expect(await lwa({ ...form, grant_type: "client_credentials" })).toBe(400);
    expect(await lwa({ ...form, client_secret: "other" })).toBe(401);
  });
});
