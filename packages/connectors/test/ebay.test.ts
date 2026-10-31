import { describe, expect, it } from "vitest";
import { runSync, writePolicy, InMemoryWriteAuditLog, WriteGate, type SourceBatch } from "@karatos/core";
import { EBAY_MOCK_SCOPES, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, ebayDocMock, ebayOrder, testPipeline, type EbayMock, type EbayMockData, type EbayMockOrder } from "@karatos/connector-testkit";
import {
  EBAY_FULFILLMENT_READ_SCOPE,
  EBAY_INCREMENTAL_LOOKBACK_DAYS,
  EBAY_MAX_RANGE_DAYS,
  EBAY_OFFSET_OVERLAP,
  EBAY_OVERLAP_MS,
  EBAY_PAGE_SIZE,
  EBAY_WRITES,
  EbayApiError,
  EbayConfigError,
  EbayShapeError,
  ebayCents,
  ebayClient,
  ebayConnector,
  ebayEnvironment,
  ebayOrderEvents,
  ebayOrdersParams,
  ebayPage,
  ebayPaymentMethod,
  ebayTime,
  ebayTimeMs,
  parseEbayCursor,
  type EbayClientOptions,
  type EbayConnectorOptions,
  type EbayCursor,
  type EbayOrderQuery,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = `TestStor-KaratOS-PRD-${"a".repeat(9)}`;
const CLIENT_SECRET = `PRD-${"s".repeat(24)}`;
const REFRESH = `v^1.1#i^1#${"r".repeat(40)}`;
const NOW = () => new Date("2026-10-20T12:00:00.000Z");
const RECEIVED = "2026-10-20T12:00:00.000Z";
const CTX = { receivedAt: RECEIVED };
const ORDERS_URL = "https://api.ebay.com/sell/fulfillment/v1/order";
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const Q: EbayOrderQuery = { field: "creationdate", from: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z", offset: 0 };

function seller(overrides: Partial<EbayMockData> = {}): EbayMockData {
  ebayOrder.reset();
  // Six orders from 2026-10-01, and one in the first month of the two years.
  const orders = [...ebayOrder.many(6), ebayOrder.one({ creationDate: "2024-11-01T09:00:00.000Z", lastModifiedDate: "2024-11-02T09:00:00.000Z" })];
  return { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, orders, ...overrides };
}

const base = (fetch?: typeof globalThis.fetch): EbayClientOptions => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, sleep: noSleep, ...(fetch ? { fetch } : {}) });

function connector(mock: EbayMock, overrides: Partial<EbayConnectorOptions> = {}) {
  return ebayConnector({ ...base(mock.fetch), now: NOW, ...overrides });
}

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const filters = (mock: EbayMock) => mock.reads.map((q) => q.get("filter"));
const offsets = (mock: EbayMock) => mock.reads.map((q) => Number(q.get("offset")));
/** A fetch that refreshes, then answers every API call with `api`. */
const fake = (api: () => Response) => (async (input: string | URL | Request) => (String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "AT", expires_in: 7200 }), { status: 200 }) : api())) as typeof fetch;
const money = (value: string) => ({ value, currency: "USD" });

/** `count` orders a minute apart from 2026-10-01, each changed a day later, so they fill one window. */
function dense(count: number): EbayMockOrder[] {
  ebayOrder.reset();
  const at = (n: number, days: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + days * DAY_MS + n * 60_000).toISOString();
  return ebayOrder.many(count, (n) => ({ creationDate: at(n, 0), lastModifiedDate: at(n, 1) }));
}

function order(overrides: Partial<EbayMockOrder> = {}, line: Record<string, unknown> = {}): EbayMockOrder {
  ebayOrder.reset();
  const o = ebayOrder.one(overrides);
  return overrides.lineItems ? o : { ...o, lineItems: [{ ...(o.lineItems as Record<string, unknown>[])[0], ...line }] };
}

describe("eBay normalizer", () => {
  it("reads amounts to the cent without floating point, and times in UTC, turning down anything else", () => {
    expect([money("125.50"), money("0.995"), money("-3.10"), money("7"), money("0.004")].map(ebayCents)).toEqual([12550, 100, -310, 700, 0]);
    expect([{ value: 12.5 }, money("1e3"), money("12.5.0"), money(""), money(`${"9".repeat(25)}`), null, "1.00"].map(ebayCents)).toEqual([null, null, null, null, null, null, null]);
    expect(ebayCents(money("-0.00"))).toBe(0);
    expect(ebayTime("2026-10-01T12:00:00.000Z")).toBe("2026-10-01T12:00:00.000Z");
    expect(ebayTime("2026-10-01T08:00:00-04:00")).toBe("2026-10-01T12:00:00.000Z");
    expect([undefined, "", "soon", 5, "x".repeat(41)].map(ebayTime)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("names how the buyer paid as the sales department does", () => {
    expect(["EBAY", "CREDIT_CARD", "PAYPAL", "CASH_ON_PICKUP", "ESCROW", undefined].map(ebayPaymentMethod)).toEqual(["card", "card", "card", "cash", "other", "other"]);
  });

  it("reads a page's orders and total, and throws on an answer that isn't one", () => {
    expect(ebayPage({ total: 0, limit: 200, offset: 0 })).toEqual({ orders: [], total: 0 });
    expect(ebayPage({ total: 2, orders: [{ orderId: "a" }, "junk"] })).toEqual({ orders: [{ orderId: "a" }, {}], total: 2 });
    for (const bad of [null, [], { orders: [] }, { orders: null, total: 1 }, { orders: {}, total: 1 }, { orders: [], total: -1 }, { orders: [], total: 1.5 }, { orders: [], total: "1" }]) {
      expect(() => ebayPage(bad), JSON.stringify(bad)).toThrow(EbayShapeError);
    }
  });

  it("turns a paid order into order.updated and sale.completed, in cents, with what eBay kept in fees", () => {
    const [updated, sale, ...rest] = ebayOrderEvents(order(), CTX);
    expect(rest).toEqual([]);
    expect(updated).toEqual({
      id: "ebay_order:01-10001-20001:2026-10-02T01:00:00.000Z",
      type: "order.updated",
      occurredAt: "2026-10-02T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "ebay:order:01-10001-20001:2026-10-02T01:00:00.000Z",
      payload: {
        orderId: "ebay:order:01-10001-20001",
        createdAt: "2026-10-01T01:00:00.000Z",
        status: "FULFILLED",
        paymentStatus: "PAID",
        cancelled: false,
        channel: "online",
        marketplace: "ebay",
        currency: "USD",
        totalCents: 25100,
        marketplaceFeeCents: 3300,
        refundedCents: 0,
        lineCount: 1,
        linesComplete: true,
      },
    });
    expect(sale).toEqual({
      id: "ebay_sale:01-10001-20001",
      type: "sale.completed",
      occurredAt: "2026-10-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "ebay:sale:01-10001-20001",
      payload: { saleId: "ebay:order:01-10001-20001", channel: "online", lines: [{ sku: "TEST-RING-1", quantity: 1, unitPriceCents: 25100, discountCents: 0 }], totalCents: 25100, payments: [{ method: "card", amountCents: 25100 }] },
    });
  });

  it("keeps nothing about the buyer: no username, name, email address, phone, address or note", () => {
    const text = JSON.stringify(ebayOrderEvents(order(), CTX));
    for (const leak of ["test_buyer", "Test Buyer", "example.test", "555-0100", "Test Street", "Testville", "10001\"", "gift wrap", "NY", "test_seller", "buyer"]) expect(text, leak).not.toContain(leak);
  });

  it("splits a line's cost into a unit price and its discount, and stands in a SKU from the listing", () => {
    const events = ebayOrderEvents(order({ pricingSummary: { total: money("180.00") } }, { sku: undefined, legacyVariationId: "55", quantity: 2, lineItemCost: money("200.00"), discountedLineItemCost: money("180.00") }), CTX);
    expect(events[1]!.payload.lines).toEqual([{ sku: "ebay-item-100000000001-55", quantity: 2, unitPriceCents: 10000, discountCents: 2000 }]);
    // A line with no discounted cost was sold at its cost.
    const plain = ebayOrderEvents(order({}, { sku: " ", discountedLineItemCost: undefined, legacyVariationId: "x" }), CTX);
    expect(plain[1]!.payload.lines).toEqual([{ sku: "ebay-item-100000000001", quantity: 1, unitPriceCents: 25100, discountCents: 0 }]);
  });

  it("makes no sale for an order not yet paid, a failed payment, a cancelled order, a zero total or a line it can't read", () => {
    const sales = (o: EbayMockOrder) => ebayOrderEvents(o, CTX).filter((e) => e.type === "sale.completed").length;
    expect(sales(order({ orderPaymentStatus: "PENDING" }))).toBe(0);
    expect(sales(order({ orderPaymentStatus: "FAILED" }))).toBe(0);
    expect(sales(order({ orderPaymentStatus: undefined }))).toBe(0);
    expect(sales(order({ cancelStatus: { cancelState: "CANCELED" } }))).toBe(0);
    expect(sales(order({ pricingSummary: { total: money("0.00") } }))).toBe(0);
    expect(sales(order({ pricingSummary: {} }))).toBe(0);
    expect(sales(order({ lineItems: [] }))).toBe(0);
    expect(sales(order({}, { quantity: 0 }))).toBe(0);
    expect(sales(order({}, { quantity: 1.5 }))).toBe(0);
    expect(sales(order({}, { quantity: -1, lineItemCost: money("0.00"), discountedLineItemCost: money("0.00") }))).toBe(0);
    expect(sales(order({}, { sku: undefined, legacyItemId: undefined }))).toBe(0);
    expect(sales(order({}, { lineItemCost: money("-1.00"), discountedLineItemCost: money("-1.00") }))).toBe(0);
    expect(sales(order({}, { lineItemCost: undefined }))).toBe(0);
    expect(sales(order({}, { discountedLineItemCost: money("999.00") }))).toBe(0);
    // A cancel that is only requested, a partial and a full refund all come after a paid sale.
    expect(sales(order({ cancelStatus: { cancelState: "IN_PROGRESS" } }))).toBe(1);
    expect(sales(order({ orderPaymentStatus: "PARTIALLY_REFUNDED" }))).toBe(1);
    expect(sales(order({ orderPaymentStatus: "FULLY_REFUNDED" }))).toBe(1);
    const cancelled = ebayOrderEvents(order({ cancelStatus: { cancelState: "CANCELED" }, orderPaymentStatus: "FULLY_REFUNDED" }), CTX)[0]!;
    expect(cancelled.payload).toMatchObject({ cancelled: true, paymentStatus: "FULLY_REFUNDED" });
  });

  it("returns a line refunded in full, and counts a partial refund in the order's refunds only", () => {
    const full = order(
      { orderPaymentStatus: "FULLY_REFUNDED", paymentSummary: { payments: [], refunds: [{ refundId: "R1", refundStatus: "REFUNDED", amount: money("151.00") }, { refundId: "R2", refundStatus: "REFUNDED", amount: money("100.00") }, { refundId: "R3", refundStatus: "PENDING", amount: money("5.00") }] } },
      { refunds: [{ refundId: "R1", refundDate: "2026-10-05T10:00:00.000Z", amount: money("151.00") }, { refundId: "R2", refundDate: "2026-10-06T10:00:00.000Z", amount: money("100.00") }, { refundId: "R4", refundDate: "soon", amount: "x" }] },
    );
    const events = ebayOrderEvents(full, CTX);
    expect(events[0]!.payload.refundedCents).toBe(25100);
    expect(events[1]!.payload.payments).toEqual([{ method: "other", amountCents: 25100 }]);
    expect(events[2]).toEqual({
      id: "ebay_return:01-10001-20001:9000000001",
      type: "sale.returned",
      occurredAt: "2026-10-06T10:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "ebay:return:01-10001-20001:9000000001",
      payload: { saleId: "ebay:order:01-10001-20001", returnId: "ebay:return:01-10001-20001:9000000001", lines: [{ sku: "TEST-RING-1", quantity: 1, refundCents: 25100 }] },
    });
    const partial = order({ paymentSummary: { refunds: [{ refundStatus: "REFUNDED", amount: money("25.00") }, { refundStatus: "REFUNDED", amount: money("-9.00") }] } }, { refunds: [{ refundId: "R1", amount: money("25.00") }] });
    const out = ebayOrderEvents(partial, CTX);
    expect(out.map((e) => e.type)).toEqual(["order.updated", "sale.completed"]);
    expect(out[0]!.payload.refundedCents).toBe(2500);
    // A full refund of a line with no readable id, SKU, quantity or price returns nothing.
    for (const line of [{ lineItemId: "x" }, { sku: undefined, legacyItemId: undefined }, { quantity: 0 }, { discountedLineItemCost: money("0.00"), lineItemCost: money("0.00") }, { discountedLineItemCost: null, lineItemCost: null }]) {
      const o = order({}, { refunds: [{ refundId: "R1", amount: money("251.00") }], ...line });
      expect(ebayOrderEvents(o, CTX).some((e) => e.type === "sale.returned"), JSON.stringify(line)).toBe(false);
    }
    // A full refund with no refund time leaves the return without an occurredAt, so the pipeline dead-letters it.
    expect(ebayOrderEvents(order({}, { refunds: [{ amount: money("251.00") }] }), CTX)[2]!.occurredAt).toBeUndefined();
  });

  it("skips a record with no order id, and leaves an unreadable time out so the pipeline dead-letters it", () => {
    expect(ebayOrderEvents({ orderId: "a b" }, CTX)).toEqual([]);
    expect(ebayOrderEvents({ orderId: "x".repeat(41) }, CTX)).toEqual([]);
    expect(ebayOrderEvents(null as never, CTX)).toEqual([]);
    const [updated] = ebayOrderEvents({ orderId: "01-1-1", lastModifiedDate: "later" }, CTX);
    expect(updated!.occurredAt).toBeUndefined();
    expect(updated!.idempotencyKey).toBe("ebay:order:01-1-1:unknown");
    expect(updated!.payload).toMatchObject({ status: null, paymentStatus: null, lineCount: 0, refundedCents: 0 });
    expect(updated!.payload).not.toHaveProperty("marketplaceFeeCents");
    expect(updated!.payload).not.toHaveProperty("currency");
    expect(ebayOrderEvents(order({ pricingSummary: { total: { value: "1.00", currency: "usd" } } }), CTX)[0]!.payload).not.toHaveProperty("currency");
  });

  it("builds fixtures that look synthetic", () => {
    assertSynthetic(seller());
  });
});

describe("eBay client", () => {
  it("builds a getOrders query only from a time filter, a checked range, the page size and an offset", () => {
    expect(Object.fromEntries(ebayOrdersParams(Q))).toEqual({ filter: "creationdate:[2026-10-01T00:00:00.000Z..2026-10-02T00:00:00.000Z]", limit: String(EBAY_PAGE_SIZE), offset: "0" });
    expect(ebayOrdersParams({ ...Q, field: "lastmodifieddate", offset: 180 }).get("filter")).toMatch(/^lastmodifieddate:\[/);
    expect(ebayOrdersParams({ ...Q, until: new Date(Date.parse(Q.from) + EBAY_MAX_RANGE_DAYS * DAY_MS).toISOString() }).get("limit")).toBe("200");
    const bad: unknown[] = [
      { ...Q, fieldgroups: "TAX_BREAKDOWN" },
      { ...Q, field: "orderfulfillmentstatus" },
      { ...Q, from: "2026-10-01" },
      { ...Q, until: "2026-10-02T00:00:00Z" },
      { ...Q, from: "2026-09-31T00:00:00.000Z" },
      { ...Q, from: "2026-10-01T00:00:00Z" },
      { ...Q, from: "2026-10-01T00:00:00.000+00:00" },
      { ...Q, until: Q.from },
      { ...Q, from: Q.until, until: Q.from },
      { ...Q, until: new Date(Date.parse(Q.from) + EBAY_MAX_RANGE_DAYS * DAY_MS + 1).toISOString() },
      { ...Q, offset: -1 },
      { ...Q, offset: 1.5 },
      { ...Q, offset: 1_000_001 },
      { ...Q, offset: "0" },
    ];
    for (const q of bad) expect(() => ebayOrdersParams(q as EbayOrderQuery), JSON.stringify(q)).toThrow(EbayConfigError);
    expect(ebayOrdersParams({ ...Q, offset: 1_000_000 }).get("offset")).toBe("1000000");
  });

  it("reads which eBay to use, and won't build without its settings", () => {
    expect(["", " production ", "SANDBOX", undefined, "live", 5].map(ebayEnvironment)).toEqual(["production", "production", "sandbox", "production", undefined, "production"]);
    expect(() => ebayClient({ ...base(), clientId: "" })).toThrow("set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET");
    expect(() => ebayClient({ ...base(), clientSecret: "has space in it" })).toThrow("set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET");
    expect(() => ebayClient({ ...base(), refreshToken: "short" })).toThrow("set EBAY_REFRESH_TOKEN");
    expect(() => ebayClient({ ...base(), environment: "live" })).toThrow("EBAY_ENVIRONMENT must be production or sandbox");
    expect(ebayClient({ ...base(), environment: "sandbox" }).environment).toBe("sandbox");
    expect(ebayClient({ ...base(), clientId: ` ${CLIENT_ID} ` }).environment).toBe("production");
  });

  it("refreshes once for the read scope alone, sends only getOrders with the token in a header, and reuses it", async () => {
    const mock = ebayDocMock(seller({ grantedScopes: [EBAY_MOCK_SCOPES.write, EBAY_MOCK_SCOPES.read] }));
    const client = ebayClient(base(mock.fetch));
    const body = await client.orders(Q);
    expect(body).toMatchObject({ total: 6, offset: 0, limit: 200 });
    await client.orders({ ...Q, offset: 3 });
    expect(mock.refreshes.map((f) => Object.fromEntries(f))).toEqual([{ grant_type: "refresh_token", refresh_token: REFRESH, scope: EBAY_FULFILLMENT_READ_SCOPE }]);
    expect(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([`POST ${TOKEN_URL}`, `GET ${ORDERS_URL}`, `GET ${ORDERS_URL}`]);
    expect(mock.fetch.calls.every((c) => !c.url.includes(REFRESH) && !c.url.includes("TEST-"))).toBe(true);
  });

  it("uses eBay's sandbox hosts when told to", async () => {
    const urls: string[] = [];
    const record = (async (input: string | URL | Request) => {
      urls.push(String(input).split("?")[0]!);
      return String(input).includes("oauth2") ? new Response(JSON.stringify({ access_token: "AT" }), { status: 200 }) : new Response(JSON.stringify({ total: 0 }), { status: 200 });
    }) as typeof fetch;
    await ebayClient({ ...base(record), environment: "sandbox" }).orders(Q);
    expect(urls).toEqual(["https://api.sandbox.ebay.com/identity/v1/oauth2/token", "https://api.sandbox.ebay.com/sell/fulfillment/v1/order"]);
  });

  it("renews the access token once on a 401, and gives up on a second", async () => {
    const mock = ebayDocMock(seller());
    const client = ebayClient(base(mock.fetch));
    await client.orders(Q);
    mock.revokeAccessTokens();
    await client.orders(Q);
    expect(mock.refreshes).toHaveLength(2);
    let calls = 0;
    const always401 = fake(() => (calls++, new Response(JSON.stringify({ errors: [{ errorId: 1001, message: "Invalid access token" }] }), { status: 401 })));
    const error = await ebayClient(base(always401)).orders(Q).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EbayApiError);
    expect(error).toMatchObject({ status: 401, code: "1001", message: "eBay answered HTTP 401: Invalid access token" });
    expect(calls).toBe(2);
  });

  it("explains an expired refresh token, a scope the seller didn't agree to and the wrong keys", async () => {
    const reason = (data: Partial<EbayMockData>, options: Partial<EbayClientOptions> = {}) => ebayClient({ ...base(ebayDocMock(seller(data)).fetch), ...options }).orders(Q).catch((e: unknown) => e as EbayApiError);
    expect(await reason({ refreshToken: `${REFRESH}x` })).toMatchObject({ status: 400, code: "invalid_grant", message: "eBay turned down the token refresh (HTTP 400, invalid_grant); the refresh token expired or was revoked, so connect the eBay account again" });
    expect(await reason({ grantedScopes: [`${EBAY_MOCK_SCOPES.read}x`] })).toMatchObject({ code: "invalid_scope", message: `eBay turned down the token refresh (HTTP 400, invalid_scope); connect the eBay account again, agreeing to ${EBAY_FULFILLMENT_READ_SCOPE}` });
    expect(await reason({}, { clientSecret: `${CLIENT_SECRET}x`, environment: "production" })).toMatchObject({ status: 401, message: "eBay turned down the token refresh (HTTP 401, invalid_client); check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are the production keys" });
    const odd = (body: unknown, status = 200) => ebayClient(base((async () => new Response(JSON.stringify(body), { status })) as typeof fetch)).orders(Q).catch((e: unknown) => e as EbayApiError);
    expect(await odd({ error: "temporarily_unavailable" }, 503)).toMatchObject({ code: "temporarily_unavailable", message: "eBay turned down the token refresh (HTTP 503, temporarily_unavailable)" });
    expect(await odd({ access_token: "" })).toMatchObject({ message: "eBay turned down the token refresh (HTTP 200)" });
    expect(await odd({ error: 5 }, 500)).toMatchObject({ code: undefined, message: "eBay turned down the token refresh (HTTP 500)" });
    expect(await odd({ error: "e".repeat(60) }, 400)).toMatchObject({ code: "e".repeat(40) });
  });

  it("uses the access token for its lifetime, less two minutes, then refreshes", async () => {
    let now = 0;
    let refreshes = 0;
    let lifetime: unknown = 600;
    const counting = (async (input: string | URL | Request) => {
      if (String(input).includes("oauth2")) return (refreshes++, new Response(JSON.stringify({ access_token: `AT${refreshes}`, expires_in: lifetime }), { status: 200 }));
      return new Response(JSON.stringify({ total: 0 }), { status: 200 });
    }) as typeof fetch;
    const client = ebayClient({ ...base(counting), clock: () => now });
    await client.orders(Q);
    now = 479_000;
    await client.orders(Q);
    expect(refreshes).toBe(1);
    now = 480_000;
    lifetime = "soon";
    await client.orders(Q);
    expect(refreshes).toBe(2);
    // Without a usable lifetime, eBay's two hours, less two minutes.
    now += 7_079_000;
    await client.orders(Q);
    expect(refreshes).toBe(2);
    now += 1000;
    lifetime = -5;
    await client.orders(Q);
    expect(refreshes).toBe(3);
    await client.orders(Q);
    expect(refreshes).toBe(3);
  });

  it("refreshes once for reads sent together", async () => {
    const mock = ebayDocMock(seller());
    const client = ebayClient(base(mock.fetch));
    await Promise.all([client.orders(Q), client.orders(Q), client.orders(Q)]);
    expect(mock.refreshes).toHaveLength(1);
  });

  it("waits out a 429 a few times, honoring Retry-After up to a cap, then gives up with a clear error", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = ebayDocMock(seller({ rateLimited: 2 }));
    expect(await ebayClient({ ...base(mock.fetch), sleep }).orders(Q)).toMatchObject({ total: 6 });
    expect(waits).toEqual([1000, 2000]);
    waits.length = 0;
    const after = ["5", "500", "0", "soon"];
    let i = 0;
    const limited = fake(() => new Response(JSON.stringify({ errors: [{ errorId: 2001, message: "Too many requests" }] }), { status: 429, headers: { "retry-after": after[i++] ?? "1" } }));
    const error = await ebayClient({ ...base(limited), sleep, rateLimitRetries: 4 }).orders(Q).catch((e: unknown) => e);
    expect(waits).toEqual([5000, 64_000, 4000, 8000]);
    expect(error).toMatchObject({ status: 429, code: "2001", message: "eBay kept rate-limiting the sync; its daily call limit resets each day, and the next sync resumes from the checkpoint" });
    waits.length = 0;
    let n = 0;
    const doubling = fake(() => (n++, new Response("{}", { status: 429 })));
    await ebayClient({ ...base(doubling), sleep, rateLimitRetries: 8 }).orders(Q).catch(() => {});
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000]);
    expect(n).toBe(9);
    n = 0;
    await ebayClient({ ...base(doubling) }).orders(Q).catch(() => {});
    expect(n).toBe(4);
  });

  it("explains a missing scope, and turns down an answer that isn't a JSON object, cutting a long error short", async () => {
    const mock = ebayDocMock(seller());
    const token = await ebayClient(base(mock.fetch)).orders(Q).then(() => mock.refreshes.length);
    expect(token).toBe(1);
    const status = (code: number, body: unknown) => ebayClient(base(fake(() => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: code })))).orders(Q).catch((e: unknown) => e as EbayApiError);
    expect(await status(403, { errors: [{ errorId: 1100, message: "Access denied" }] })).toMatchObject({ status: 403, code: "1100", message: `eBay answered HTTP 403: Access denied; the eBay account must agree to ${EBAY_FULFILLMENT_READ_SCOPE} when it connects` });
    expect(await status(500, { errors: [{ errorId: "x", message: "m".repeat(300) }] })).toMatchObject({ code: undefined, message: `eBay answered HTTP 500: ${"m".repeat(200)}` });
    expect(await status(500, { errors: [{ errorId: 1.5 }] })).toMatchObject({ code: undefined, message: "eBay answered HTTP 500" });
    expect(await status(502, "<html>")).toMatchObject({ message: "eBay answered HTTP 502" });
    expect(await status(500, { errors: "x" })).toMatchObject({ message: "eBay answered HTTP 500" });
    for (const body of ["<html>", "[]", "null", "5"]) expect(await status(200, body)).toMatchObject({ status: 200, message: "eBay did not answer with JSON" });
  });

  it("checks a query before any request is sent", async () => {
    const mock = ebayDocMock(seller());
    await expect(ebayClient(base(mock.fetch)).orders({ ...Q, offset: -1 })).rejects.toThrow(EbayConfigError);
    expect(mock.fetch.calls).toEqual([]);
  });
});

describe("eBay connector", () => {
  it("passes every runSync scenario: full import, replay, resume and retry", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(ebayDocMock(seller())), expected: { ingested: 14 } });
    expect(result.full.batches).toBe(24);
    expect(parseEbayCursor(result.full.cursor)).toMatchObject({ pass: "historical", done: true, field: "creationdate", from: "2024-10-21T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z" });
  });

  it("reads the two years getOrders reaches by creation time, in 31-day windows up to now, with no gap", async () => {
    const mock = ebayDocMock(seller());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(14);
    const read = filters(mock).map((f) => /^creationdate:\[(.+)\.\.(.+)\]$/.exec(f!)!.slice(1));
    expect(read).toHaveLength(24);
    expect(read[0]).toEqual(["2024-10-21T12:00:00.000Z", "2024-11-21T12:00:00.000Z"]);
    expect(read[23]![1]).toBe("2026-10-20T12:00:00.000Z");
    for (let i = 1; i < read.length; i++) expect(read[i]![0]).toBe(read[i - 1]![1]);
    expect(memory.events.every((e) => e.source === "ebay")).toBe(true);
    expect(memory.events.map((e) => e.type).sort()).toEqual([...Array(7).fill("order.updated"), ...Array(7).fill("sale.completed")]);
  });

  it("never reads further back than two years, whatever history is asked for", async () => {
    const mock = ebayDocMock(seller());
    await drain(connector(mock, { historyYears: 5 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(filters(mock)[0]).toMatch(/^creationdate:\[2024-10-21T12:00:00\.000Z\.\./);
    mock.reads.length = 0;
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(filters(mock)[0]).toMatch(/^creationdate:\[2025-10-21T12:00:00\.000Z\.\./);
  });

  it("pages through a full window, starting each next page a few orders early", async () => {
    const mock = ebayDocMock({ ...seller(), orders: dense(230) });
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const window = mock.reads.find((q) => q.get("offset") !== "0")!.get("filter");
    const october = mock.reads.filter((q) => q.get("filter") === window);
    expect(october.map((q) => Number(q.get("offset")))).toEqual([0, 200 - EBAY_OFFSET_OVERLAP]);
    expect(october[1]!.get("filter")).toBe(october[0]!.get("filter"));
    // The next window starts again from its first order.
    expect(offsets(mock).filter((o) => o !== 0)).toEqual([180]);
    expect(EBAY_OFFSET_OVERLAP).toBe(20);
    expect(batches.flatMap((b) => b.events)).toHaveLength(2 * (230 + EBAY_OFFSET_OVERLAP));
    expect(batches).toHaveLength(25);
  });

  it("always moves on, even when eBay answers fewer orders than the overlap", async () => {
    let calls = 0;
    const client = { environment: "production" as const, orders: async (q: EbayOrderQuery) => (calls++, { total: 3, orders: q.offset < 3 ? [{ orderId: `01-${q.offset}-1` }] : [] }) };
    const batches = await drain(connector(ebayDocMock(seller()), { client, now: () => new Date("2024-11-01T12:00:00.000Z"), historyYears: 2 }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(batches.map((b) => parseEbayCursor(b.cursor)!.offset)).toEqual([1, 2, 0]);
    expect(calls).toBe(3);
    // A page that comes back empty while eBay still counts more ends the window.
    const empty = { environment: "production" as const, orders: async () => ({ total: 5 }) };
    expect(await drain(connector(ebayDocMock(seller()), { client: empty }).incrementalSync({ organizationId: TEST_ORG, cursor: null }))).toHaveLength(1);
  });

  it("reads orders changed since the last pass, less fifteen minutes, storing a changed order as a new version", async () => {
    const data = seller();
    const mock = ebayDocMock(data);
    const { memory, pipeline } = testPipeline();
    let now = new Date("2026-10-04T12:00:00.000Z");
    const c = connector(mock, { now: () => now });
    const first = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(filters(mock)).toEqual(["lastmodifieddate:[2026-09-27T12:00:00.000Z..2026-10-04T12:00:00.000Z]"]);
    expect(first.ingested).toBe(12);
    mock.reads.length = 0;
    // One order ships; nothing else changes.
    data.orders[1] = { ...data.orders[1]!, orderFulfillmentStatus: "FULFILLED", lastModifiedDate: "2026-10-05T09:00:00.000Z" };
    now = new Date("2026-10-06T12:00:00.000Z");
    const report = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(filters(mock)).toEqual(["lastmodifieddate:[2026-10-04T11:45:00.000Z..2026-10-06T12:00:00.000Z]"]);
    expect([report.ingested, report.duplicates]).toEqual([1, 1]);
    expect(EBAY_OVERLAP_MS).toBe(15 * 60_000);
  });

  it("starts an incremental sync with no checkpoint a week back, and reads a long gap in windows", async () => {
    const mock = ebayDocMock(seller());
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(filters(mock)).toEqual(["lastmodifieddate:[2026-10-13T12:00:00.000Z..2026-10-20T12:00:00.000Z]"]);
    expect(EBAY_INCREMENTAL_LOOKBACK_DAYS).toBe(7);
    mock.reads.length = 0;
    const old: EbayCursor = { pass: "incremental", done: true, field: "lastmodifieddate", from: "2026-07-01T00:00:00.000Z", until: "2026-08-01T00:15:00.000Z", windowStart: "2026-07-01T00:00:00.000Z", offset: 0 };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(old) }));
    expect(filters(mock)).toEqual([
      "lastmodifieddate:[2026-08-01T00:00:00.000Z..2026-09-01T00:00:00.000Z]",
      "lastmodifieddate:[2026-09-01T00:00:00.000Z..2026-10-02T00:00:00.000Z]",
      "lastmodifieddate:[2026-10-02T00:00:00.000Z..2026-10-20T12:00:00.000Z]",
    ]);
  });

  it("keeps an incremental pass inside what getOrders can read, even from a checkpoint ahead of the clock or years old", async () => {
    const mock = ebayDocMock(seller());
    const ahead: EbayCursor = { pass: "incremental", done: true, field: "lastmodifieddate", from: "2026-11-01T00:00:00.000Z", until: "2026-12-31T00:00:00.000Z", windowStart: "2026-11-01T00:00:00.000Z", offset: 0 };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ahead) }));
    expect(filters(mock)).toEqual(["lastmodifieddate:[2026-10-20T11:59:59.999Z..2026-10-20T12:00:00.000Z]"]);
    mock.reads.length = 0;
    const ancient: EbayCursor = { ...ahead, from: "2020-01-01T00:00:00.000Z", until: "2020-02-01T00:00:00.000Z", windowStart: "2020-01-01T00:00:00.000Z" };
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(ancient) }));
    expect(filters(mock)[0]).toBe("lastmodifieddate:[2024-10-21T12:00:00.000Z..2024-11-21T12:00:00.000Z]");
  });

  it("resumes an unfinished pass from its window and offset, and keeps a finished import finished", async () => {
    const mock = ebayDocMock({ ...seller(), orders: dense(230) });
    const first = await drain(connector(mock, { now: () => new Date("2026-10-04T12:00:00.000Z") }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const mid = parseEbayCursor(first[0]!.cursor)!;
    expect(mid.offset).toBe(180);
    mock.reads.length = 0;
    const rest = await drain(connector(mock, { now: () => new Date("2026-10-04T12:00:00.000Z") }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(offsets(mock)).toEqual([180]);
    expect(filters(mock)).toEqual([`lastmodifieddate:[${mid.windowStart}..${mid.until}]`]);
    expect(rest).toHaveLength(1);
    mock.reads.length = 0;
    const done: EbayCursor = { pass: "historical", done: true, field: "creationdate", from: "2024-10-21T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z", windowStart: "2024-10-21T12:00:00.000Z", offset: 0 };
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.reads).toEqual([]);
    // An interrupted import picks up where it stopped, not two years back.
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, done: false, windowStart: "2026-10-01T00:00:00.000Z" }) }));
    expect(filters(mock)[0]).toBe("creationdate:[2026-10-01T00:00:00.000Z..2026-10-20T12:00:00.000Z]");
    mock.reads.length = 0;
    // An incremental sync after a finished import reads changes from just before it ended.
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...done, until: "2026-10-15T00:00:00.000Z" }) }));
    expect(filters(mock)[0]).toBe("lastmodifieddate:[2026-10-14T23:45:00.000Z..2026-10-20T12:00:00.000Z]");
  });

  it("dead-letters an order with an unreadable time and stores the rest", async () => {
    const good = order();
    const client = { environment: "production" as const, orders: async () => ({ total: 2, orders: [{ orderId: "01-1-1", lastModifiedDate: "nope" }, good] }) };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(ebayDocMock(seller()), { client }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([report.ingested, report.deadLettered]).toEqual([2, 1]);
  });

  it("turns down a checkpoint that isn't one of its own", () => {
    expect(parseEbayCursor(null)).toBeNull();
    const ok: EbayCursor = { pass: "historical", done: false, field: "creationdate", from: "2024-10-21T12:00:00.000Z", until: "2026-10-20T12:00:00.000Z", windowStart: "2025-01-01T00:00:00.000Z", offset: 0 };
    expect(parseEbayCursor(JSON.stringify(ok))).toEqual(ok);
    expect(parseEbayCursor(JSON.stringify({ ...ok, field: "lastmodifieddate", offset: 180, windowStart: ok.until }))!.offset).toBe(180);
    expect(parseEbayCursor(JSON.stringify({ ...ok, windowStart: ok.from }))!.windowStart).toBe(ok.from);
    const bad: unknown[] = [
      null,
      {},
      { ...ok, pass: "full" },
      { ...ok, done: "no" },
      { ...ok, field: "paymentdate" },
      { ...ok, from: "2024-10-21" },
      { ...ok, until: undefined },
      { ...ok, windowStart: "2025-13-01T00:00:00.000Z" },
      { ...ok, from: "2026-10-21T00:00:00.000Z" },
      { ...ok, from: "2026-10-21T00:00:00.000Z", windowStart: "2026-10-21T00:00:00.000Z" },
      { ...ok, windowStart: "2024-10-21T11:59:59.999Z" },
      { ...ok, windowStart: "2026-10-20T12:00:00.001Z" },
      { ...ok, offset: -1 },
      { ...ok, offset: 1.5 },
      { ...ok, offset: "0" },
    ];
    for (const c of bad) expect(() => parseEbayCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("not in the expected shape");
  });

  it("declares setting a listing's quantity and price and adding tracking, each needing approval, and a read-only gate turns all three down", async () => {
    const c = connector(ebayDocMock(seller()));
    expect(c.source).toBe("ebay");
    expect(c.writes).toBe(EBAY_WRITES);
    expect(EBAY_WRITES.map((w) => [w.name, w.kind, w.approval, w.dailyCap])).toEqual([
      ["set_listing_quantity", "update", "each", 20],
      ["set_listing_price", "update", "each", 10],
      ["add_tracking", "append", "each", 20],
    ]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.integration, a.action, a.outcome])).toEqual([
      ["ebay", "set_listing_quantity", "refused"],
      ["ebay", "set_listing_price", "refused"],
      ["ebay", "add_tracking", "refused"],
    ]);
  });

  it("lets a write through only where the instance turned it on, by name", async () => {
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: writePolicy(["ebay:set_listing_quantity"]), audit });
    const ran: string[] = [];
    for (const action of EBAY_WRITES) await gate.run(action, "test", async () => void ran.push(action.name)).catch(() => {});
    expect(ran).toEqual(["set_listing_quantity"]);
    expect(audit.entries.map((a) => a.outcome)).toEqual(["performed", "refused", "refused"]);
  });

  it("never asks eBay for anything but orders, with a read-only token, and never sends a shipment", async () => {
    const mock = ebayDocMock({ ...seller({ grantedScopes: [EBAY_MOCK_SCOPES.read, EBAY_MOCK_SCOPES.write] }), orders: dense(230) });
    await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    for (const q of mock.reads) expect([...q.keys()]).toEqual(["filter", "limit", "offset"]);
    expect(mock.refreshes.every((f) => f.get("scope") === EBAY_FULFILLMENT_READ_SCOPE)).toBe(true);
    expect(mock.writes).toBe(0);
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`))).toEqual(new Set([`POST ${TOKEN_URL}`, `GET ${ORDERS_URL}`]));
  });
});

describe("the eBay mock", () => {
  it("turns down a bad filter or limit, and a shipment from a token with the read scope only", async () => {
    const mock = ebayDocMock(seller({ grantedScopes: [EBAY_MOCK_SCOPES.read, EBAY_MOCK_SCOPES.write] }));
    await ebayClient(base(mock.fetch)).orders(Q);
    const auth = { authorization: "Bearer v^1.1#i^1#TEST-1" };
    const get = (query: string) => mock.fetch(`${ORDERS_URL}?${query}`, { headers: auth }).then((r) => r.status);
    expect(await get("filter=orderfulfillmentstatus:{NOT_STARTED}")).toBe(400);
    expect(await get("limit=201")).toBe(400);
    expect(await get("offset=-1")).toBe(400);
    expect(await get(`filter=${encodeURIComponent("creationdate:[2026-10-02T00:00:00.000Z..2026-10-01T00:00:00.000Z]")}`)).toBe(400);
    expect(await get("")).toBe(200);
    const ship = await mock.fetch(`${ORDERS_URL}/01-10001-20001/shipping_fulfillment`, { method: "POST", headers: auth, body: "{}" });
    expect(ship.status).toBe(403);
    expect(mock.writes).toBe(1);
    expect(ebayTimeMs("2026-10-01T00:00:00Z")).toBeNaN();
  });
});
