import { beforeEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  SQUARE_MOCK_ALL_SCOPES,
  SQUARE_MOCK_HOST,
  SQUARE_MOCK_READ_SCOPES,
  SQUARE_TEST_APPLICATION,
  SQUARE_TEST_MERCHANT,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  squareCount,
  squareCustomer,
  squareDocMock,
  squareItem,
  squareLocation,
  squareOrder,
  squarePayment,
  squareRefund,
  squareTestId,
  tamper,
  testPipeline,
  type SquareMock,
  type SquareMockData,
  type SquareMockRecord,
} from "@karatos/connector-testkit";
import {
  SQUARE_API_VERSION,
  SQUARE_HOSTS,
  SQUARE_READ_SCOPES,
  SQUARE_REPLAY_WINDOW_MS,
  SQUARE_ROUTES,
  SQUARE_WRITES,
  SquareApiError,
  SquareConfigError,
  SquareCustomerKeyError,
  SquareReplayGuard,
  parseSquareCursor,
  squareCents,
  squareClient,
  squareConnector,
  squareCountEvent,
  squareCustomerEvent,
  squareCustomerRef,
  squareItemEvents,
  squareNotification,
  squareOrderEvents,
  squarePaymentEvent,
  squarePaymentMethod,
  squareQuantity,
  squareRefundEvent,
  squareScopeProblems,
  squareTime,
  squareWebhookEvents,
  verifySquareWebhook,
  type SquareConnectorOptions,
  type SquareContext,
  type SquareCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["customer", "ref", "key", "0".repeat(40)].join("-");
const OTHER_KEY = ["customer", "ref", "key", "1".repeat(40)].join("-");
const SECRET = ["sandbox", "app", "secret", "0".repeat(30)].join("-");
const REFRESH = ["refresh", "test", "0".repeat(30)].join("-");
const PERSONAL = ["personal", "token", "0".repeat(30)].join("-");
const READ_ONLY = ["read", "only", "token", "0".repeat(26)].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const id = squareTestId;
const money = (amount: number) => ({ amount, currency: "USD" });

const resetBuilders = () => {
  for (const b of [squareLocation, squareItem, squareCount, squareCustomer, squareOrder, squarePayment, squareRefund]) b.reset();
};

function seller(overrides: Partial<SquareMockData> = {}): SquareMockData {
  resetBuilders();
  const items = squareItem.many(3);
  // A variation sold without a SKU, and an item deleted since.
  ((items[1]!.item_data as SquareMockRecord).variations as SquareMockRecord[])[0]!.item_variation_data = { item_id: id("ITEM", 2), name: "Regular", price_money: money(48_000) };
  items[2]!.is_deleted = true;
  const sale = squareOrder.one();
  const open = squareOrder.one({ state: "OPEN", tenders: [], closed_at: undefined });
  // One order Square returned without its update time: dead-lettered, not given a made-up one.
  delete open.updated_at;
  const returned = squareOrder.one({
    line_items: [],
    tenders: [],
    total_money: money(0),
    returns: [{ uid: "ret-1", source_order_id: id("ORDER", 1), return_line_items: [{ uid: "rl-1", quantity: "1", catalog_object_id: id("VAR", 1), total_money: money(5_000) }] }],
  });
  const cash = squareOrder.one({
    location_id: id("LOC", 2),
    customer_id: undefined,
    // A variation deleted since: no item lists it, so its SKU comes from the catalog's deleted objects.
    line_items: [{ uid: "uid-cash", quantity: "2", catalog_object_id: id("VAR", 9), base_price_money: money(30_000), total_discount_money: money(0), total_money: money(60_000) }],
    tenders: [{ id: id("PAY", 4), type: "CASH", amount_money: money(60_000) }],
    total_money: money(60_000),
  });
  const payments = squarePayment.many(2);
  payments[1]!.location_id = id("LOC", 2);
  return {
    locations: squareLocation.many(2),
    items,
    deletedVariations: [{ type: "ITEM_VARIATION", id: id("VAR", 9), updated_at: "2025-06-01T00:00:00Z", item_variation_data: { item_id: id("ITEM", 9), name: "Size 7", sku: "SKU-TEST-0009" } }],
    counts: [...squareCount.many(2), squareCount.one({ state: "SOLD" })],
    customers: squareCustomer.many(2),
    orders: [sale, open, returned, cash],
    payments,
    refunds: squareRefund.many(1),
    oauth: { applicationSecret: SECRET, refreshToken: REFRESH, granted: SQUARE_MOCK_READ_SCOPES },
    tokens: { [PERSONAL]: SQUARE_MOCK_ALL_SCOPES, [READ_ONLY]: SQUARE_MOCK_READ_SCOPES },
    now: NOW,
    ...overrides,
  };
}

const options = (mock: SquareMock, extra: Partial<SquareConnectorOptions> = {}): SquareConnectorOptions => ({
  environment: "sandbox",
  applicationId: SQUARE_TEST_APPLICATION,
  applicationSecret: SECRET,
  refreshToken: REFRESH,
  customerKey: KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  random: () => 0,
  now: NOW,
  ...extra,
});
const connector = (mock: SquareMock, extra: Partial<SquareConnectorOptions> = {}) => squareConnector(options(mock, extra));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const paths = (mock: SquareMock) => mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

/** A fetch that records each request's headers and body before the mock answers it. */
function recording(mock: SquareMock) {
  const sent: { method: string; url: string; version: string | null; auth: string | null; body: Record<string, unknown> | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as string, init);
    const text = request.method === "POST" ? await request.clone().text() : "";
    sent.push({ method: request.method, url: request.url, version: request.headers.get("square-version"), auth: request.headers.get("authorization"), body: text ? (JSON.parse(text) as Record<string, unknown>) : null });
    return mock.fetch(request);
  };
  return { fetch, sent };
}

/** Answers token calls from the mock and every read with `answer`. */
const readsAnswer = (mock: SquareMock, answer: () => Response): typeof globalThis.fetch => async (input, init) =>
  new URL(String(input)).pathname.startsWith("/oauth2/") ? mock.fetch(input as string, init) : answer();

const ctx = (key = KEY): SquareContext => ({ receivedAt: RECEIVED, customerRef: (v) => squareCustomerRef(key, v), sku: (v) => (v === id("VAR", 1) ? "SKU-TEST-0001" : `square-variation-${v}`) });

describe("Square client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(squareDocMock(seller()));
    expect(() => squareClient({ ...base, environment: "staging" })).toThrow(new SquareConfigError("SQUARE_ENVIRONMENT must be production or sandbox"));
    expect(() => squareClient({ ...base, refreshToken: " " })).toThrow("set all of SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET and SQUARE_REFRESH_TOKEN");
    expect(() => squareClient({ ...base, applicationId: "", applicationSecret: "", refreshToken: "" })).toThrow("or SQUARE_ACCESS_TOKEN");
    expect(squareClient({ ...base, applicationId: "", applicationSecret: "", refreshToken: "", accessToken: READ_ONLY, environment: "" }).baseUrl).toBe(SQUARE_HOSTS.production);
    expect(squareClient(base).baseUrl).toBe(SQUARE_MOCK_HOST);
    expect(SQUARE_HOSTS).toEqual({ production: "https://connect.squareup.com", sandbox: "https://connect.squareupsandbox.com" });
  });

  it("reads only its listed endpoints with their listed parameters, before any request is made", async () => {
    const mock = squareDocMock(seller());
    const client = squareClient(options(mock));
    await expect(client.read("payments/../../v2/customers" as never)).rejects.toThrow(new SquareConfigError("the Square connector only reads its listed endpoints"));
    await expect(client.read("toString" as never)).rejects.toThrow(SquareConfigError);
    await expect(client.read("payments", { location_id: "x", note: "x" })).rejects.toThrow("the Square connector doesn't send note to /v2/payments");
    await expect(client.read("ordersSearch", { location_ids: ["x"], idempotency_key: "x" })).rejects.toThrow("doesn't send idempotency_key");
    await expect(client.read("payments", { cursor: { nested: true } })).rejects.toThrow("cursor must be a plain value");
    expect(mock.fetch.calls).toEqual([]);
    expect(Object.values(SQUARE_ROUTES).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v2/locations",
      "POST /v2/catalog/search",
      "POST /v2/catalog/batch-retrieve",
      "POST /v2/inventory/counts/batch-retrieve",
      "POST /v2/customers/search",
      "POST /v2/orders/search",
      "GET /v2/payments",
      "GET /v2/refunds",
    ]);
  });

  it("refreshes with the read scopes only, checks the token's scopes, then reads with Square-Version pinned", async () => {
    const mock = squareDocMock(seller({ oauth: { applicationSecret: SECRET, refreshToken: REFRESH, granted: [...SQUARE_MOCK_READ_SCOPES, "ORDERS_WRITE"] } }));
    const { fetch, sent } = recording(mock);
    const client = squareClient(options(mock, { fetch }));
    const body = await client.read("payments", { location_id: id("LOC", 1), begin_time: "2021-01-20T00:00:00.000Z", sort_order: "ASC" });
    expect(Array.isArray(body.payments)).toBe(true);
    expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["POST /oauth2/token", "POST /oauth2/token/status", "GET /v2/payments"]);
    // The seller granted a write scope once; the refreshed token is limited to the reads anyway.
    expect(sent[0]!.body).toEqual({ client_id: SQUARE_TEST_APPLICATION, client_secret: SECRET, grant_type: "refresh_token", refresh_token: REFRESH, scopes: [...SQUARE_READ_SCOPES] });
    expect(sent[0]!.auth).toBeNull();
    expect(sent.every((s) => s.version === SQUARE_API_VERSION)).toBe(true);
    expect(sent[1]!.auth).toMatch(/^Bearer sq-mock-access-1$/);
    expect(new URL(sent[2]!.url).searchParams.get("sort_order")).toBe("ASC");
    expect(client.merchantId()).toBe(SQUARE_TEST_MERCHANT);
    expect(SQUARE_API_VERSION).toBe("2026-09-16");
  });

  it("reuses the token for 30 days less a day, and refreshes once when Square revokes it early", async () => {
    const mock = squareDocMock(seller());
    let t = NOW().getTime();
    const client = squareClient(options(mock, { clock: () => t }));
    await client.read("locations");
    t += 28 * 86_400_000;
    await client.read("locations");
    expect(mock.refreshes).toBe(1);
    t += 1.5 * 86_400_000;
    await client.read("locations");
    expect([mock.refreshes, mock.statusChecks]).toEqual([2, 2]);
    // Concurrent reads share one refresh.
    const fresh = squareClient(options(mock));
    await Promise.all([1, 2, 3].map(() => fresh.read("locations")));
    expect(mock.refreshes).toBe(3);
    mock.revokeAccessTokens();
    await fresh.read("locations");
    expect(mock.refreshes).toBe(4);
    // A token Square keeps refusing after one refresh is an error, not a loop.
    const refused = readsAnswer(mock, () => new Response(JSON.stringify({ errors: [{ code: "ACCESS_TOKEN_REVOKED" }] }), { status: 401 }));
    await expect(squareClient(options(mock, { fetch: refused })).read("locations")).rejects.toMatchObject({ status: 401, code: "ACCESS_TOKEN_REVOKED" });
    // A static token is never refreshed: a 401 is reported as it is.
    const reader = squareClient({ ...options(mock, { fetch: refused }), applicationId: "", applicationSecret: "", refreshToken: "", accessToken: READ_ONLY });
    await expect(reader.read("locations")).rejects.toMatchObject({ status: 401 });
  });

  it("stops a personal access token, which can do everything, without reading anything", async () => {
    const mock = squareDocMock(seller());
    const client = squareClient({ ...options(mock), applicationId: "", applicationSecret: "", refreshToken: "", accessToken: PERSONAL });
    const error = await failure(client.read("locations"));
    expect(error).toBeInstanceOf(SquareConfigError);
    expect(error.message).toBe(
      `the Square token can do more than read (MERCHANT_PROFILE_WRITE, ITEMS_WRITE, INVENTORY_WRITE, CUSTOMERS_WRITE, ORDERS_WRITE); connect with only ${SQUARE_READ_SCOPES.join(" ")}`,
    );
    expect(paths(mock)).toEqual(["POST /oauth2/token/status"]);
    // A read-only token is checked once and then used as it is.
    const reader = squareClient({ ...options(mock), applicationId: "", applicationSecret: "", refreshToken: "", accessToken: READ_ONLY });
    await reader.read("locations");
    await reader.read("locations");
    expect(paths(mock).slice(1)).toEqual(["POST /oauth2/token/status", "GET /v2/locations", "GET /v2/locations"]);
  });

  it("stops a token with any other scope, an unscoped one, or one missing a read it needs", async () => {
    const tokens = { a: [...SQUARE_MOCK_READ_SCOPES, "DISPUTES_READ"], b: [], c: SQUARE_MOCK_READ_SCOPES.filter((s) => s !== "CUSTOMERS_READ"), d: [...SQUARE_MOCK_READ_SCOPES, "PAYMENTS_WRITE_IN_PERSON"] };
    const mock = squareDocMock(seller({ tokens }));
    const read = (token: string) => failure(squareClient({ ...options(mock), applicationId: "", applicationSecret: "", refreshToken: "", accessToken: token }).read("locations"));
    expect((await read("a")).message).toMatch(/^the Square token can do more than read \(DISPUTES_READ\)/);
    expect((await read("b")).message).toMatch(/\(full access \(no scopes listed\)\)/);
    expect((await read("c")).message).toBe(`the Square token is missing CUSTOMERS_READ; connect with ${SQUARE_READ_SCOPES.join(" ")}`);
    expect((await read("d")).message).toMatch(/\(PAYMENTS_WRITE_IN_PERSON\)/);
    expect(mock.fetch.calls.filter((c) => c.url.includes("/v2/"))).toEqual([]);
    // An OAuth refresh that comes back with more than the reads is stopped the same way.
    const broad = squareDocMock(seller());
    const answer: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/oauth2/token") return new Response(JSON.stringify({ access_token: PERSONAL, expires_at: "2026-02-19T00:00:00Z" }), { status: 200 });
      return broad.fetch(input as string, init);
    };
    await expect(squareClient(options(broad, { fetch: answer })).read("locations")).rejects.toThrow(/can do more than read/);
  });

  it("tells read scopes from the rest, and never echoes an odd scope name", () => {
    expect(squareScopeProblems([...SQUARE_READ_SCOPES])).toEqual({ extra: [], missing: [] });
    expect(squareScopeProblems([...SQUARE_READ_SCOPES, "ITEMS_WRITE", "ITEMS_WRITE"])).toEqual({ extra: ["ITEMS_WRITE"], missing: [] });
    expect(squareScopeProblems(["x".repeat(500), "orders_read", ...SQUARE_READ_SCOPES])).toEqual({ extra: ["an unreadable scope"], missing: [] });
    expect(squareScopeProblems([])).toEqual({ extra: ["full access (no scopes listed)"], missing: [...SQUARE_READ_SCOPES] });
    expect(SQUARE_MOCK_READ_SCOPES).toEqual([...SQUARE_READ_SCOPES]);
  });

  it("backs off on 429 with jitter, honours Retry-After up to a minute, then leaves the error to runSync", async () => {
    const waits: number[] = [];
    const mock = squareDocMock(seller({ rateLimits: [{}, { retryAfter: 7 }, { retryAfter: 3600 }] }));
    await squareClient(options(mock, { sleep: async (ms) => void waits.push(ms), random: () => 0.5 })).read("locations");
    expect(waits).toEqual([1500, 7000, 60_000]);
    const always = readsAnswer(mock, () => new Response(JSON.stringify({ errors: [{ code: "RATE_LIMITED" }] }), { status: 429 }));
    const backoff: number[] = [];
    const error = await failure(squareClient(options(mock, { fetch: always, sleep: async (ms) => void backoff.push(ms) })).read("locations"));
    expect(backoff).toEqual([1000, 2000, 4000]);
    expect(error).toMatchObject({ name: "SquareApiError", status: 429, code: "RATE_LIMITED", message: "Square kept rate-limiting the sync; the next run resumes from the checkpoint" });
  });

  it("reports Square's errors cut short, with a hint for missing scopes, and never a token or secret", async () => {
    const mock = squareDocMock(seller());
    const long = readsAnswer(mock, () => new Response(JSON.stringify({ errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail: "x".repeat(500) }] }), { status: 400 }));
    const cut = await failure(squareClient(options(mock, { fetch: long })).read("locations"));
    expect(cut.message.length).toBeLessThan(280);
    const scoped = readsAnswer(mock, () => new Response(JSON.stringify({ errors: [{ code: "INSUFFICIENT_SCOPES", detail: "ORDERS_READ is required." }] }), { status: 403 }));
    const forbidden = await failure(squareClient(options(mock, { fetch: scoped })).read("locations"));
    expect(forbidden.message).toBe(`Square answered HTTP 403 (INSUFFICIENT_SCOPES: ORDERS_READ is required.); connect with ${SQUARE_READ_SCOPES.join(" ")}`);
    const bare = readsAnswer(mock, () => new Response("not json", { status: 500 }));
    await expect(squareClient(options(mock, { fetch: bare })).read("locations")).rejects.toThrow(new SquareApiError("Square answered HTTP 500", 500));
    const list = readsAnswer(mock, () => new Response("[]", { status: 200 }));
    await expect(squareClient(options(mock, { fetch: list })).read("locations")).rejects.toThrow("Square did not answer with a JSON object");
    const refused = await failure(squareClient(options(mock, { refreshToken: ["revoked", "0".repeat(30)].join("-") })).read("locations"));
    expect(refused.message).toBe("Square's token refresh answered HTTP 401 (UNAUTHORIZED: Invalid refresh token); reconnect Square if the refresh token was revoked");
    const oldStyle = readsAnswer(mock, () => new Response("{}"));
    const legacy: typeof globalThis.fetch = async (input, init) =>
      new URL(String(input)).pathname === "/oauth2/token" ? new Response(JSON.stringify({ type: "bad_request", message: "missing field" }), { status: 400 }) : oldStyle(input, init);
    await expect(squareClient(options(mock, { fetch: legacy })).read("locations")).rejects.toThrow("(bad_request: missing field)");
    const empty: typeof globalThis.fetch = async (input) =>
      new URL(String(input)).pathname === "/oauth2/token" ? new Response("{}", { status: 200 }) : new Response("{}");
    await expect(squareClient(options(mock, { fetch: empty })).read("locations")).rejects.toThrow("answered without an access token");
    const statusDown: typeof globalThis.fetch = async (input, init) =>
      new URL(String(input)).pathname === "/oauth2/token/status" ? new Response("{}", { status: 503 }) : mock.fetch(input as string, init);
    await expect(squareClient(options(mock, { fetch: statusDown })).read("locations")).rejects.toThrow("Square's token status check answered HTTP 503");
    for (const message of [cut.message, forbidden.message, refused.message]) {
      for (const secret of [SECRET, REFRESH, KEY, "sq-mock-access"]) expect(message).not.toContain(secret);
    }
  });
});

describe("Square normalization", () => {
  beforeEach(resetBuilders);
  const all = () => {
    const data = seller();
    return [
      ...data.items!.flatMap((i) => squareItemEvents(i, ctx())),
      ...data.counts!.flatMap((c) => squareCountEvent(c, ctx()) ?? []),
      ...data.customers!.flatMap((c) => squareCustomerEvent(c, ctx()) ?? []),
      ...data.orders!.flatMap((o) => squareOrderEvents(o, ctx())),
      ...data.payments!.flatMap((p) => squarePaymentEvent(p, ctx()) ?? []),
      ...data.refunds!.flatMap((r) => squareRefundEvent(r, ctx()) ?? []),
    ];
  };

  it("keeps nothing personal: no names, contact details, notes, card digits or Square's customer IDs", () => {
    const text = JSON.stringify(all());
    for (const personal of ["@", "555", "Test Street", "Testville", "Customer 1", "Synthetic", "0000\"", "fingerprint", "2030", "REF-TEST", "RECEIPT-TEST", "receipt", "1990-01-01", id("CUST", 1), "Size 6", "engraving"]) {
      expect(text, personal).not.toContain(personal);
    }
  });

  it("gives a completed order the Shopify connector's order and sale events, with each tender", () => {
    const [order] = squareOrder.many(1);
    const events = squareOrderEvents(order!, ctx());
    const customerId = squareCustomerRef(KEY, id("CUST", 1));
    expect(events.map((e) => [e.type, e.idempotencyKey])).toEqual([
      ["order.updated", `square:order:${id("ORDER", 1)}:2026-01-01T03:00:00.000Z`],
      ["sale.completed", `square:sale:${id("ORDER", 1)}`],
    ]);
    expect(events[0]!.payload).toEqual({
      orderId: `square:order:${id("ORDER", 1)}`,
      locationId: `square:location:${id("LOC", 1)}`,
      createdAt: "2026-01-01T01:00:00.000Z",
      state: "COMPLETED",
      channel: "store",
      currency: "USD",
      totalCents: 120_000,
      lineCount: 1,
      linesComplete: true,
      customerId,
    });
    expect(events[1]).toMatchObject({
      occurredAt: "2026-01-01T02:00:00.000Z",
      payload: { saleId: `square:order:${id("ORDER", 1)}`, customerId, channel: "store", lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 125_000, discountCents: 5_000 }], totalCents: 120_000, payments: [{ method: "card", amountCents: 120_000 }] },
    });
    expect(customerId).toMatch(/^square:customer:[0-9a-f]{32}$/);
  });

  it("records no sale until an order is completed and every line can be read", () => {
    const base = squareOrder.one();
    const types = (o: SquareMockRecord) => squareOrderEvents(o, ctx()).map((e) => e.type);
    expect(types({ ...base, state: "OPEN" })).toEqual(["order.updated"]);
    expect(types({ ...base, total_money: money(0) })).toEqual(["order.updated"]);
    expect(types({ ...base, line_items: [] })).toEqual(["order.updated"]);
    // A measured quantity, a missing price and a line with nothing to key it by.
    expect(types({ ...base, line_items: [{ uid: "u", quantity: "1.5", catalog_object_id: id("VAR", 1), base_price_money: money(100) }] })).toEqual(["order.updated"]);
    expect(types({ ...base, line_items: [{ uid: "u", quantity: "1", catalog_object_id: id("VAR", 1) }] })).toEqual(["order.updated"]);
    expect(types({ ...base, line_items: [{ quantity: "1", base_price_money: money(100) }] })).toEqual(["order.updated"]);
    const cancelled = squareOrderEvents({ ...base, state: "CANCELED" }, ctx())[0]!.payload;
    expect(cancelled.cancelledAt).toBe("2026-01-01T03:00:00.000Z");
    // A custom amount rung up without a catalog item gets a stand-in SKU.
    const custom = squareOrderEvents({ ...base, line_items: [{ uid: "u-9", quantity: "1", base_price_money: money(100) }] }, ctx())[1]!.payload;
    expect(custom.lines).toEqual([{ sku: `square-line-${id("ORDER", 1)}-u-9`, quantity: 1, unitPriceCents: 100, discountCents: 0 }]);
    expect(squareOrderEvents({ ...base, id: "../x" }, ctx())).toEqual([]);
    expect(squareOrderEvents(null as never, ctx())).toEqual([]);
  });

  it("maps Square tenders to the sales department's payment methods, splitting a sale paid several ways", () => {
    expect(["CARD", "THIRD_PARTY_CARD", "CASH", "SQUARE_GIFT_CARD", "BUY_NOW_PAY_LATER", "BANK_ACCOUNT", "WALLET", "SQUARE_ACCOUNT", "EXTERNAL", "OTHER", undefined, "card"].map(squarePaymentMethod)).toEqual([
      "card", "card", "cash", "gift_card", "financing", "wire", "other", "other", "other", "other", "other", "other",
    ]);
    const split = squareOrder.one({
      tenders: [
        { type: "CASH", amount_money: money(20_000) },
        { type: "SQUARE_GIFT_CARD", amount_money: money(100_000) },
        { type: "NO_SALE", amount_money: money(0) },
        { type: "CARD", amount_money: { amount: "x" } },
      ],
    });
    expect(squareOrderEvents(split, ctx())[1]!.payload.payments).toEqual([
      { method: "cash", amountCents: 20_000 },
      { method: "gift_card", amountCents: 100_000 },
    ]);
    expect(squareOrderEvents({ ...split, tenders: [] }, ctx())[1]!.payload.payments).toEqual([{ method: "other", amountCents: 120_000 }]);
    // Square Online orders are online sales; the customer can come from the tender.
    const online = squareOrderEvents({ ...split, source: { name: "Square Online" }, customer_id: undefined, tenders: [{ type: "CARD", amount_money: money(120_000), customer_id: id("CUST", 2) }] }, ctx());
    expect(online[1]!.payload).toMatchObject({ channel: "online", customerId: squareCustomerRef(KEY, id("CUST", 2)) });
  });

  it("turns each return in a return order into a sale.returned against the original sale", () => {
    const returned = squareOrder.one({
      line_items: [],
      returns: [
        { uid: "ret-1", source_order_id: id("ORDER", 1), return_line_items: [{ quantity: "1", catalog_object_id: id("VAR", 1), total_money: money(5_000) }] },
        // Unlinked: no original sale, so it is recorded against the return order itself.
        { uid: "ret-2", return_line_items: [{ uid: "x", quantity: "2", catalog_object_id: id("VAR", 7), total_money: money(9_000) }] },
        { uid: "ret-3", return_line_items: [] },
        { return_line_items: [{ quantity: "1", catalog_object_id: id("VAR", 1), total_money: money(1) }] },
      ],
    });
    const events = squareOrderEvents(returned, ctx()).filter((e) => e.type === "sale.returned");
    const orderId = String(returned.id);
    expect(events.map((e) => [e.idempotencyKey, e.payload])).toEqual([
      [`square:return:${orderId}:ret-1`, { saleId: `square:order:${id("ORDER", 1)}`, returnId: `square:return:${orderId}:ret-1`, lines: [{ sku: "SKU-TEST-0001", quantity: 1, refundCents: 5_000 }] }],
      [`square:return:${orderId}:ret-2`, { saleId: `square:order:${orderId}`, returnId: `square:return:${orderId}:ret-2`, lines: [{ sku: `square-variation-${id("VAR", 7)}`, quantity: 2, refundCents: 9_000 }] }],
    ]);
    expect(squareOrderEvents({ ...returned, state: "OPEN" }, ctx()).map((e) => e.type)).toEqual(["order.updated"]);
  });

  it("gives payments and refunds the Stripe connector's shapes, keeping only the card's brand", () => {
    const [payment] = squarePayment.many(1);
    expect(squarePaymentEvent(payment!, ctx())).toEqual({
      id: `square_payment:${id("PAY", 1)}:2026-01-01T02:00:00.000Z`,
      type: "payment.charge_updated",
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `square:payment:${id("PAY", 1)}:2026-01-01T02:00:00.000Z`,
      payload: {
        chargeId: `square:payment:${id("PAY", 1)}`,
        status: "completed",
        paid: true,
        captured: true,
        amountCents: 120_000,
        capturedCents: 120_000,
        refundedCents: 0,
        currency: "usd",
        method: "card",
        cardBrand: "VISA",
        orderId: `square:order:${id("ORDER", 1)}`,
        locationId: `square:location:${id("LOC", 1)}`,
        customerId: squareCustomerRef(KEY, id("CUST", 1)),
      },
    });
    const pending = squarePaymentEvent({ ...payment!, status: "APPROVED", refunded_money: money(500), card_details: { card: { card_brand: "x".repeat(50) } }, source_type: "CASH" }, ctx())!.payload;
    expect(pending).toMatchObject({ status: "approved", paid: false, captured: false, capturedCents: 0, refundedCents: 500, cardBrand: null, method: "cash" });
    const [refund] = squareRefund.many(1);
    expect(squareRefundEvent(refund!, ctx())).toMatchObject({
      idempotencyKey: `square:refund:${id("REFUND", 1)}:COMPLETED`,
      occurredAt: "2026-01-01T11:00:00.000Z",
      payload: { refundId: `square:refund:${id("REFUND", 1)}`, chargeId: `square:payment:${id("PAY", 1)}`, orderId: `square:order:${id("RETURN", 1)}`, amountCents: 5_000, currency: "usd", status: "completed", reason: null },
    });
    expect([squarePaymentEvent({ id: "" }, ctx()), squareRefundEvent({ id: 5 }, ctx())]).toEqual([null, null]);
    expect(squarePaymentEvent({ id: "P1" }, ctx())!.payload).toEqual({ chargeId: "square:payment:P1", status: null, paid: false, captured: false, amountCents: null, capturedCents: 0, refundedCents: 0, method: "other", cardBrand: null });
    expect(squareRefundEvent({ id: "R1" }, ctx())).toMatchObject({ idempotencyKey: "square:refund:R1:unknown", payload: { refundId: "square:refund:R1", amountCents: null, status: null, reason: null } });
  });

  it("gives catalog items the Shopify connector's product shape, deleted and archived ones included", () => {
    const item = squareItem.one();
    expect(squareItemEvents(item, ctx())).toEqual([
      {
        id: `square_product:${String(item.id)}:2026-01-01T01:00:00.000Z:ACTIVE`,
        type: "product.updated",
        occurredAt: "2026-01-01T01:00:00.000Z",
        receivedAt: RECEIVED,
        idempotencyKey: `square:product:${String(item.id)}:2026-01-01T01:00:00.000Z:ACTIVE`,
        payload: {
          productId: `square:item:${String(item.id)}`,
          title: "Test 14K Ring 1",
          status: "ACTIVE",
          vendor: null,
          productType: "REGULAR",
          tags: [],
          variants: [{ variantId: `square:variation:${id("VAR", 1)}`, sku: "SKU-TEST-0001", priceCents: 125_001, inventoryQuantity: null }],
        },
      },
    ]);
    expect(squareItemEvents({ ...item, is_deleted: true }, ctx())[0]!.payload.status).toBe("DELETED");
    expect(squareItemEvents({ ...item, item_data: { is_archived: true, variations: [{ id: "V9" }, { id: "../" }] } }, ctx())[0]!.payload).toMatchObject({
      title: `Square item ${String(item.id)}`,
      status: "ARCHIVED",
      productType: null,
      variants: [{ variantId: "square:variation:V9", sku: "square-variation-V9", priceCents: null, inventoryQuantity: null }],
    });
    expect(squareItemEvents({ ...item, type: "CATEGORY" }, ctx())).toEqual([]);
    expect(squareItemEvents({ id: "I1", type: "ITEM" }, ctx())[0]!.payload.variants).toEqual([]);
  });

  it("gives counts the POS connector's inventory.counted shape, per location", () => {
    const count = squareCount.one();
    expect(squareCountEvent(count, ctx())).toMatchObject({
      idempotencyKey: `square:count:${id("VAR", 1)}:${id("LOC", 1)}:2026-01-01T01:00:00.000Z`,
      payload: { sku: "SKU-TEST-0001", onHand: 1, variantId: `square:variation:${id("VAR", 1)}`, locationId: `square:location:${id("LOC", 1)}` },
    });
    expect(squareCountEvent({ ...count, quantity: "2.5" }, ctx())!.payload.onHand).toBeNull();
    expect(squareCountEvent({ ...count, quantity: "-3" }, ctx())!.payload.onHand).toBe(-3);
    expect([squareCountEvent({ ...count, state: "SOLD" }, ctx()), squareCountEvent({ ...count, location_id: undefined }, ctx())]).toEqual([null, null]);
  });

  it("makes customers profiles under a keyed reference, with consent never assumed", () => {
    const customer = squareCustomer.one();
    const event = squareCustomerEvent(customer, ctx())!;
    const ref = squareCustomerRef(KEY, customer.id)!;
    expect(event.payload).toEqual({ customerId: ref, name: `Square customer ${ref.slice(16, 24)}`, marketingConsent: false });
    expect(event.idempotencyKey).toBe(`square:customer:${ref.slice(16)}:2026-01-01T02:00:00.000Z`);
    expect(JSON.stringify(event)).not.toContain(String(customer.id));
    expect(squareCustomerEvent({ ...customer, id: undefined }, ctx())).toBeNull();
  });

  it("keys customer references with CUSTOMER_REF_KEY, so they link up but can't be looked up without it", () => {
    const a = squareCustomerRef(KEY, id("CUST", 1));
    expect(squareCustomerRef(KEY, id("CUST", 1))).toBe(a);
    expect(squareCustomerRef(OTHER_KEY, id("CUST", 1))).not.toBe(a);
    expect(squareCustomerRef(KEY, id("CUST", 2))).not.toBe(a);
    for (const bad of ["", "x".repeat(192), "../1", 5, null]) expect(squareCustomerRef(KEY, bad)).toBeUndefined();
    expect(() => squareCustomerRef("short", id("CUST", 1))).toThrow(SquareCustomerKeyError);
    expect(() => squareConnector({ ...options(squareDocMock(seller())), customerKey: " " })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("reads Square's times, money and quantities, and dead-letters what it can't", () => {
    expect(squareTime("2026-01-19T12:00:00Z")).toBe("2026-01-19T12:00:00.000Z");
    expect(squareTime("2026-01-19T12:00:00.123-05:00")).toBe("2026-01-19T17:00:00.123Z");
    for (const bad of ["soon", "", 5, undefined, "2026-13-45T00:00:00Z", `2026-01-19T12:00:00Z${" ".repeat(40)}`, "Monday, 19 January 2026 12:00:00 GMT+0000 (Coordinated Universal Time)"]) expect(squareTime(bad)).toBeUndefined();
    expect([squareCents(money(10)), squareCents({ amount: 1.5 }), squareCents({ amount: "5" }), squareCents(undefined)]).toEqual([10, null, null, null]);
    expect([squareQuantity("3"), squareQuantity("-1"), squareQuantity("1.0"), squareQuantity(""), squareQuantity(3), squareQuantity("1".repeat(13))]).toEqual([3, -1, null, null, null, null]);
    const timeless = squareOrderEvents({ ...squareOrder.one(), updated_at: undefined }, ctx())[0]!;
    expect([timeless.occurredAt, timeless.idempotencyKey.endsWith(":unknown")]).toEqual([undefined, true]);
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(seller())).not.toThrow();
  });

  it("runs its patterns in linear time on hostile input", () => {
    const hostile = "A".repeat(200_000);
    const started = performance.now();
    squareTime(`${"9".repeat(100_000)}T`);
    squareQuantity("1".repeat(100_000));
    squareNotification({ event_id: hostile, type: `${"a.".repeat(100_000)}!`, merchant_id: hostile, data: { type: "a".repeat(100_000) + "!", id: hostile } });
    verifySquareWebhook(KEY, "https://example.test/hook", "{}", `${"A".repeat(100_000)}!`);
    verifySquareWebhook(KEY, "https://example.test/hook", "{}", ` ${"A".repeat(43)}`.padEnd(99, "A"));
    squareScopeProblems([`${"A_".repeat(100_000)}!`]);
    squareOrderEvents({ id: "O1", state: "COMPLETED", source: { name: `${"web ".repeat(100_000)}` }, line_items: [{ uid: hostile, catalog_object_id: `${hostile}!` }] }, ctx());
    squareItemEvents({ id: hostile, type: "ITEM" }, ctx());
    squarePaymentEvent({ id: "P", status: `${"A_".repeat(100_000)}a`, card_details: { card: { card_brand: hostile } } }, ctx());
    expect(() => parseSquareCursor(JSON.stringify({ pass: "historical", step: "catalog", page: `${"!".repeat(100_000)} `, location: 0 }))).toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("Square sync", () => {
  it("imports, replays, resumes and retries the mocked seller", async () => {
    // 3 items; 2 counts; 2 customers; orders: a sale (2 events), an open order, a return order (2) and a cash sale (2);
    // the open order's order.updated is dead-lettered for its missing update time; 2 payments and 1 refund.
    const result = await checkConnectorSync({ makeConnector: () => connector(squareDocMock(seller())), expected: { ingested: 16, deadLettered: 1 } });
    expect(result.full.batches).toBe(7);
    expect(parseSquareCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", page: null, location: 0 });
  });

  it("reads every stream five years back across every location, looking up only the SKUs it hasn't seen", async () => {
    const mock = squareDocMock(seller());
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const reads = sent.filter((s) => !new URL(s.url).pathname.startsWith("/oauth2/"));
    expect(reads.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "POST /v2/catalog/search",
      "POST /v2/inventory/counts/batch-retrieve",
      "POST /v2/customers/search",
      "GET /v2/locations",
      "POST /v2/orders/search",
      "POST /v2/catalog/batch-retrieve",
      "GET /v2/payments",
      "GET /v2/payments",
      "GET /v2/refunds",
    ]);
    const body = (path: string) => reads.find((s) => s.url.endsWith(path))!.body;
    expect(body("/v2/catalog/search")).toEqual({ object_types: ["ITEM"], include_deleted_objects: true, limit: 1000 });
    expect(body("/v2/inventory/counts/batch-retrieve")).toEqual({ states: ["IN_STOCK"], limit: 1000 });
    expect(body("/v2/customers/search")).toEqual({ limit: 100, query: { filter: { updated_at: { start_at: "2021-01-20T00:00:00.000Z", end_at: RECEIVED } }, sort: { field: "CREATED_AT", order: "ASC" } } });
    expect(body("/v2/orders/search")).toEqual({
      location_ids: [id("LOC", 1), id("LOC", 2)],
      limit: 500,
      return_entries: false,
      query: { filter: { date_time_filter: { created_at: { start_at: "2021-01-20T00:00:00.000Z", end_at: RECEIVED } }, state_filter: { states: ["OPEN", "COMPLETED", "CANCELED"] } }, sort: { sort_field: "CREATED_AT", sort_order: "ASC" } },
    });
    // The catalog search already gave variations 1 to 3; only the deleted variation 9 is looked up.
    expect(body("/v2/catalog/batch-retrieve")).toEqual({ object_ids: [id("VAR", 9)], include_deleted_objects: true });
    const payments = reads.filter((s) => s.url.includes("/v2/payments")).map((s) => Object.fromEntries(new URL(s.url).searchParams));
    expect(payments).toEqual([
      { location_id: id("LOC", 1), begin_time: "2021-01-20T00:00:00.000Z", sort_order: "ASC", limit: "100" },
      { location_id: id("LOC", 2), begin_time: "2021-01-20T00:00:00.000Z", sort_order: "ASC", limit: "100" },
    ]);
    expect(Object.fromEntries(new URL(reads.at(-1)!.url).searchParams)).toEqual({ begin_time: "2021-01-20T00:00:00.000Z", sort_order: "ASC", limit: "100" });
    const cash = memory.events.find((e) => e.idempotencyKey === `square:sale:${id("ORDER", 4)}`)!;
    expect(cash.payload).toMatchObject({ lines: [{ sku: "SKU-TEST-0009", quantity: 2 }], payments: [{ method: "cash", amountCents: 60_000 }] });
    const counted = memory.events.filter((e) => e.type === "inventory.counted").map((e) => e.payload.sku);
    expect(counted.sort()).toEqual([`square-variation-${id("VAR", 2)}`, "SKU-TEST-0001"].sort());
  });

  it("asks the catalog for variations it hasn't read this run, and keeps a stand-in for ones Square no longer has", async () => {
    const data = seller();
    const mock = squareDocMock(data);
    const orders = [
      squareOrder.one({ line_items: [{ uid: "a", quantity: "1", catalog_object_id: id("VAR", 2), base_price_money: money(1), total_discount_money: money(0) }] }),
      squareOrder.one({ line_items: [{ uid: "b", quantity: "1", catalog_object_id: "GONEVARIATION", base_price_money: money(1), total_discount_money: money(0) }] }),
    ];
    const resumed: SquareCursor = { pass: "historical", step: "orders", page: null, location: 0, since: "2021-01-20T00:00:00.000Z", until: RECEIVED, historyFrom: "2021-01-20T00:00:00.000Z", nextFrom: RECEIVED };
    const batches = [];
    for await (const b of connector(squareDocMock({ ...data, orders }), {}).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) })) batches.push(b);
    const sales = batches[0]!.events.filter((e) => (e as { type: string }).type === "sale.completed") as { payload: { lines: { sku: string }[] } }[];
    // Variation 2 has no SKU in Square, so it keeps the stand-in the catalog stream gives it too.
    expect(sales.map((s) => s.payload.lines[0]!.sku)).toEqual([`square-variation-${id("VAR", 2)}`, "square-variation-GONEVARIATION"]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(squareDocMock(seller())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 16, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(
      new Set(["product.updated", "inventory.counted", "customer.profile_updated", "order.updated", "sale.completed", "sale.returned", "payment.charge_updated", "payment.refund_updated"]),
    );
    expect(memory.events.filter((e) => e.type === "sale.completed")).toHaveLength(2);
  });

  it("searches orders ten locations at a time and pages payments per location", async () => {
    const data = seller();
    squareLocation.reset();
    squarePayment.reset();
    data.locations = squareLocation.many(11);
    data.payments = squarePayment.many(101);
    const mock = squareDocMock(data);
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const groups = sent.filter((s) => s.url.endsWith("/v2/orders/search")).map((s) => (s.body!.location_ids as string[]).length);
    expect(groups).toEqual([10, 1]);
    const pays = sent.filter((s) => s.url.includes("/v2/payments")).map((s) => new URL(s.url).searchParams);
    expect(pays.map((q) => [q.get("location_id"), q.has("cursor")])).toEqual([
      [id("LOC", 1), false],
      [id("LOC", 1), true],
      ...Array.from({ length: 10 }, (_, i) => [id("LOC", i + 2), false]),
    ]);
    expect(memory.events.filter((e) => e.type === "payment.charge_updated")).toHaveLength(101);
    // Catalog, inventory and customers; two order searches; 11 locations of payments, one with a second page; refunds.
    expect(report.batches).toBe(3 + 2 + 12 + 1);
  });

  it("leaves a finished import finished", async () => {
    const done: SquareCursor = { pass: "historical", step: "done", page: null, location: 0, since: "2021-01-20T00:00:00.000Z", until: RECEIVED, historyFrom: "2021-01-20T00:00:00.000Z", nextFrom: RECEIVED };
    const mock = squareDocMock(seller());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads changes since the last pass started, and starts the next a little before this one", async () => {
    const data = seller();
    data.payments![0]!.updated_at = "2026-01-19T10:00:00.000Z";
    data.items![0]!.updated_at = "2026-01-19T10:00:00.000Z";
    data.counts![0]!.calculated_at = "2026-01-19T10:00:00.000Z";
    const mock = squareDocMock(data);
    const { fetch, sent } = recording(mock);
    const previous: SquareCursor = { pass: "incremental", step: "done", page: null, location: 0, since: "2026-01-18T00:00:00.000Z", until: "2026-01-19T00:00:00.000Z", historyFrom: "2021-01-19T00:00:00.000Z", nextFrom: "2026-01-19T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "square", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 3, duplicates: 0 });
    expect(memory.events.map((e) => e.type).sort()).toEqual(["inventory.counted", "payment.charge_updated", "product.updated"]);
    const since = "2026-01-19T00:00:00.000Z";
    const body = (path: string) => sent.find((s) => s.url.endsWith(path))!.body;
    expect(body("/v2/catalog/search")!.begin_time).toBe(since);
    expect(body("/v2/inventory/counts/batch-retrieve")!.updated_after).toBe(since);
    expect(body("/v2/customers/search")!.query).toMatchObject({ filter: { updated_at: { start_at: since, end_at: RECEIVED } } });
    expect(body("/v2/orders/search")!.query).toMatchObject({ filter: { date_time_filter: { updated_at: { start_at: since, end_at: RECEIVED } } }, sort: { sort_field: "UPDATED_AT" } });
    const pay = new URL(sent.find((s) => s.url.includes("/v2/payments"))!.url).searchParams;
    // Old payments refunded today still count: creation is filtered five years back, changes from the checkpoint.
    expect([pay.get("begin_time"), pay.get("updated_at_begin_time")]).toEqual(["2021-01-20T00:00:00.000Z", since]);
    expect(parseSquareCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", page: null, location: 0, since, until: RECEIVED, historyFrom: "2021-01-20T00:00:00.000Z", nextFrom: "2026-01-19T23:55:00.000Z" });
  });

  it("looks back 48 hours on a first incremental sync, and resumes an interrupted pass where it stopped", async () => {
    const mock = squareDocMock(seller());
    const { fetch, sent } = recording(mock);
    for await (const _ of connector(mock, { fetch }).incrementalSync({ organizationId: TEST_ORG, cursor: null })) break;
    expect(sent.find((s) => s.url.endsWith("/v2/catalog/search"))!.body!.begin_time).toBe("2026-01-18T00:00:00.000Z");
    const stopped: SquareCursor = { pass: "incremental", step: "payments", page: null, location: 1, since: "2026-01-19T00:00:00.000Z", until: "2026-01-19T23:00:00.000Z", historyFrom: "2021-01-19T23:00:00.000Z", nextFrom: "2026-01-19T22:55:00.000Z" };
    const fresh = squareDocMock(seller());
    const batches = [];
    for await (const b of connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) batches.push(b);
    expect(fresh.fetch.calls.filter((c) => c.url.includes("/v2/")).map((c) => new URL(c.url).searchParams.get("location_id") ?? new URL(c.url).pathname)).toEqual(["/v2/locations", id("LOC", 2), "/v2/refunds"]);
    expect(batches).toHaveLength(2);
    expect(parseSquareCursor(batches.at(-1)!.cursor)!.nextFrom).toBe("2026-01-19T22:55:00.000Z");
  });

  it("stops when Square keeps rate-limiting, keeps the checkpoint where it was, and carries on from there", async () => {
    const mock = squareDocMock(seller());
    const { memory, pipeline } = testPipeline();
    let reads = 0;
    let limited = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      if (request.url.includes("/v2/") && ++reads >= 3 && limited) return new Response(JSON.stringify({ errors: [{ code: "RATE_LIMITED" }] }), { status: 429 });
      return mock.fetch(request);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "SquareApiError", code: "RATE_LIMITED" });
    expect(parseSquareCursor(await memory.getCheckpoint(TEST_ORG, "square", "historical"))).toMatchObject({ step: "customers", page: null });
    limited = false;
    const resumed = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([resumed.batches, resumed.duplicates]).toEqual([5, 0]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: SquareCursor = { pass: "incremental", step: "orders", page: "Y3Vyc29y", location: 1, since: "2026-01-19T00:00:00.000Z", until: RECEIVED, historyFrom: "2021-01-20T00:00:00.000Z", nextFrom: RECEIVED };
    expect(parseSquareCursor(JSON.stringify(good))).toEqual(good);
    expect(parseSquareCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "employees" },
      { ...good, page: "" },
      { ...good, page: "has space" },
      { ...good, page: "x".repeat(4097) },
      { ...good, page: 5 },
      { ...good, location: -1 },
      { ...good, location: 1.5 },
      { ...good, location: 10_001 },
      { ...good, since: "2026-01-19" },
      { ...good, until: "2026-13-45T00:00:00Z" },
      { ...good, historyFrom: undefined },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      null,
      "text",
    ]) {
      expect(() => parseSquareCursor(JSON.stringify(bad))).toThrow("Square checkpoint is not in the expected shape");
    }
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(squareDocMock(seller()));
    expect(c.writes).toBe(SQUARE_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => a.action)).toEqual(["adjust_inventory", "update_catalog_item"]);
    expect(c).not.toHaveProperty("write");
  });
});

describe("Square webhooks", () => {
  beforeEach(resetBuilders);
  const SIGNATURE_KEY = ["signature", "key", "0".repeat(30)].join("-");
  const URL_ = "https://brain.example.test/webhooks/square";
  const delivery = (type: string, object: Record<string, unknown>, eventId = "00000000-0000-4000-8000-000000000001") =>
    JSON.stringify({ merchant_id: SQUARE_TEST_MERCHANT, type, event_id: eventId, created_at: "2026-01-19T12:00:00Z", data: { type: type.split(".")[0], id: String(Object.values(object)[0] && (Object.values(object)[0] as { id?: string }).id), object } });

  it("accepts a delivery signed over the notification URL and raw body, and rejects everything else", () => {
    const body = delivery("payment.updated", { payment: squarePayment.one() });
    const signature = hmacSha256(SIGNATURE_KEY, URL_ + body, "base64");
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, body, signature)).toEqual({ ok: true });
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, Buffer.from(body), ` ${signature} `)).toEqual({ ok: true });
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, tamper(body), signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySquareWebhook(SIGNATURE_KEY, `${URL_}/other`, body, signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySquareWebhook(`${SIGNATURE_KEY}x`, URL_, body, signature)).toEqual({ ok: false, reason: "mismatch" });
    // Signed over the body alone, as some vendors do: not Square's scheme.
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, body, hmacSha256(SIGNATURE_KEY, body, "base64"))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifySquareWebhook("", URL_, body, signature)).toEqual({ ok: false, reason: "missing" });
    expect(verifySquareWebhook(SIGNATURE_KEY, "", body, signature)).toEqual({ ok: false, reason: "missing" });
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, body, hmacSha256(SIGNATURE_KEY, URL_ + body, "hex"))).toEqual({ ok: false, reason: "malformed" });
    expect(verifySquareWebhook(SIGNATURE_KEY, URL_, body, `${signature}${" ".repeat(100)}`)).toEqual({ ok: false, reason: "malformed" });
  });

  it("handles each event ID once within Square's retry window, as Square signs no timestamp", () => {
    let t = 0;
    const guard = new SquareReplayGuard({ clock: () => t });
    expect(guard.firstDelivery("evt-1")).toBe(true);
    expect(guard.firstDelivery("evt-1")).toBe(false);
    t += SQUARE_REPLAY_WINDOW_MS - 1;
    expect(guard.firstDelivery("evt-1")).toBe(false);
    expect(guard.firstDelivery("evt-2")).toBe(true);
    t += SQUARE_REPLAY_WINDOW_MS + 1;
    expect(guard.firstDelivery("evt-1")).toBe(true);
    const small = new SquareReplayGuard({ maxEntries: 2, clock: () => 0 });
    expect(["a", "b", "c", "a", "c"].map((e) => small.firstDelivery(e))).toEqual([true, true, true, true, false]);
    expect(SQUARE_REPLAY_WINDOW_MS).toBeGreaterThan(24 * 3_600_000);
  });

  it("turns payment, refund and customer notifications into the sync's own events, and treats the rest as prompts", () => {
    const payment = squarePayment.one();
    const refund = squareRefund.one();
    const customer = squareCustomer.one();
    const events = (body: string, merchant?: string) => squareWebhookEvents(JSON.parse(body), ctx(), merchant);
    expect(events(delivery("payment.updated", { payment }))).toEqual([squarePaymentEvent(payment, ctx())]);
    expect(events(delivery("refund.created", { refund }))).toEqual([squareRefundEvent(refund, ctx())]);
    expect(events(delivery("customer.updated", { customer }), SQUARE_TEST_MERCHANT)).toEqual([squareCustomerEvent(customer, ctx())]);
    expect(events(delivery("payment.updated", { payment }), "SOMEONEELSE")).toEqual([]);
    expect(events(delivery("order.updated", { order_updated: { order_id: id("ORDER", 1), version: 2 } }))).toEqual([]);
    expect(events(delivery("customer.deleted", { customer }))).toEqual([]);
    expect(events(delivery("payment.updated", { refund }))).toEqual([]);
    expect(events(delivery("payment.updated", { payment: { id: "../x" } }))).toEqual([]);
    for (const bad of [null, "x", [], { type: "payment.updated" }, { event_id: "e", type: "PAYMENT" }, { event_id: "e", type: "payment.updated", data: { type: "payment", object: [] } }]) {
      expect(squareWebhookEvents(bad, ctx())).toEqual([]);
    }
    expect(squareNotification(JSON.parse(delivery("payment.updated", { payment })))).toMatchObject({ eventId: "00000000-0000-4000-8000-000000000001", type: "payment.updated", merchantId: SQUARE_TEST_MERCHANT, objectType: "payment", objectId: id("PAY", 1) });
  });

  it("stores a webhook for a record the sync already read, or a replayed one, as a duplicate", async () => {
    const mock = squareDocMock(seller());
    const c = connector(mock, { merchantId: SQUARE_TEST_MERCHANT });
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    squarePayment.reset();
    const body = JSON.parse(delivery("payment.updated", { payment: squarePayment.one() }));
    const raw = c.handleWebhook!(body);
    expect(raw).toHaveLength(1);
    const ingest = () => pipeline.ingest({ ...(raw[0] as object), organizationId: TEST_ORG, source: "square" });
    expect((await ingest()).duplicate).toBe(true);
    expect((await ingest()).duplicate).toBe(true);
    expect(c.handleWebhook!({ ...body, merchant_id: "SOMEONEELSE" })).toEqual([]);
  });
});

describe("Square doc mock", () => {
  const call = async (mock: SquareMock, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await mock.fetch(`${SQUARE_MOCK_HOST}${path}`, {
      method,
      headers: { "square-version": SQUARE_API_VERSION, authorization: `Bearer ${READ_ONLY}`, ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const json = (await response.json()) as { errors?: { code: string }[]; [k: string]: unknown };
    return { status: response.status, code: json.errors?.[0]?.code, json };
  };

  it("answers like Square to requests the connector should never send", async () => {
    const mock = squareDocMock(seller({ tokens: { [READ_ONLY]: SQUARE_MOCK_READ_SCOPES, nothing: ["ITEMS_READ"] } }));
    expect((await call(mock, "GET", "/v2/locations", undefined, { "square-version": "" })).code).toBe("INVALID_SQUARE_VERSION_FORMAT");
    expect((await call(mock, "GET", "/v2/locations", undefined, { authorization: "Bearer unknown" })).status).toBe(401);
    expect((await call(mock, "GET", "/v2/locations", undefined, { authorization: "Bearer nothing" })).code).toBe("INSUFFICIENT_SCOPES");
    expect((await call(mock, "POST", "/oauth2/token/status", {}, { authorization: "" })).status).toBe(401);
    expect((await call(mock, "POST", "/oauth2/token", { grant_type: "authorization_code" })).status).toBe(401);
    expect((await call(squareDocMock({ locations: [] }), "POST", "/oauth2/token", { grant_type: "refresh_token" })).status).toBe(401);
    const ok = { location_ids: [id("LOC", 1)] };
    for (const [path, body] of [
      ["/v2/catalog/search", "nope"],
      ["/v2/catalog/search", { object_types: ["ITEM"], begin_time: "soon" }],
      ["/v2/catalog/batch-retrieve", { object_ids: [] }],
      ["/v2/inventory/counts/batch-retrieve", "nope"],
      ["/v2/inventory/counts/batch-retrieve", { limit: 5000 }],
      ["/v2/inventory/counts/batch-retrieve", { updated_after: "soon" }],
      ["/v2/customers/search", "nope"],
      ["/v2/customers/search", { limit: 0 }],
      ["/v2/customers/search", { limit: 101 }],
      ["/v2/customers/search", { query: { filter: { updated_at: { start_at: "2026-01-01T00:00:00Z" } } } }],
      ["/v2/orders/search", "nope"],
      ["/v2/orders/search", { location_ids: Array.from({ length: 11 }, (_, i) => `L${i}`) }],
      ["/v2/orders/search", { ...ok, limit: 1001 }],
      ["/v2/orders/search", { ...ok, query: { filter: { date_time_filter: { created_at: {}, updated_at: {} } } } }],
      ["/v2/orders/search", { ...ok, query: { filter: { date_time_filter: { updated_at: {} } }, sort: { sort_field: "CREATED_AT" } } }],
      ["/v2/orders/search", { ...ok, query: { sort: { sort_field: "CLOSED_AT" } } }],
      ["/v2/orders/search", { ...ok, cursor: "bm90LWEtY3Vyc29y" }],
    ] as const) {
      expect((await call(mock, "POST", path, body)).status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await call(mock, "GET", "/v2/payments?begin_time=soon")).status).toBe(400);
    expect((await call(mock, "GET", "/v2/refunds?updated_at_begin_time=soon")).status).toBe(400);
    expect((await call(mock, "POST", "/v2/catalog/search", { object_types: ["CATEGORY"] })).json).toEqual({});
  });

  it("keeps the documented defaults: a year of payments at the main location, newest first", async () => {
    const data = seller();
    data.payments = [squarePayment.one({ created_at: "2024-01-01T00:00:00Z" }), squarePayment.one(), squarePayment.one({ location_id: id("LOC", 2) })];
    const mock = squareDocMock(data);
    const listed = (await call(mock, "GET", "/v2/payments")).json.payments as { id: string }[];
    expect(listed.map((p) => p.id)).toEqual([String(data.payments[1]!.id)]);
    const counts = (await call(mock, "POST", "/v2/inventory/counts/batch-retrieve", {})).json.counts as { calculated_at: string }[];
    expect(counts.map((c) => c.calculated_at)).toEqual([...counts.map((c) => c.calculated_at)].sort().reverse());
    const customers = (await call(mock, "POST", "/v2/customers/search", { query: { sort: { field: "CREATED_AT", order: "DESC" } } })).json.customers as { id: string }[];
    expect(customers.map((c) => c.id)).toEqual([id("CUST", 2), id("CUST", 1)]);
    const orders = (await call(mock, "POST", "/v2/orders/search", { location_ids: [id("LOC", 1)], query: { filter: { state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "CLOSED_AT" } } })).json.orders as { id: string }[];
    expect(orders.map((o) => o.id)).toEqual([id("ORDER", 3), id("ORDER", 1)]);
  });
});
