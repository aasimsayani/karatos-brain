import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  CLOVER_MOCK_HOST,
  CLOVER_TEST_APP,
  CLOVER_TEST_MERCHANT,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  cloverCustomer,
  cloverDocMock,
  cloverItem,
  cloverMs,
  cloverOrder,
  cloverPayment,
  cloverRefund,
  cloverStock,
  cloverTestId,
  notCardLike,
  testPipeline,
  type CloverMock,
  type CloverMockData,
} from "@karatos/connector-testkit";
import {
  CLOVER_HOSTS,
  CLOVER_OVERLAP_MS,
  CLOVER_PAGE_SIZE,
  CLOVER_REPLAY_WINDOW_MS,
  CLOVER_WINDOW_MS,
  CLOVER_WRITES,
  CLOVER_CUSTOMER_REF_PREFIX,
  CloverApiError,
  CloverConfigError,
  CloverCustomerKeyError,
  CloverWebhookDeduper,
  cardSummary,
  cloverClient,
  cloverConnector,
  cloverNormalizer,
  cloverPageRequest,
  cloverPaymentMethod,
  cloverTime,
  cloverVerificationCode,
  cloverWebhookChanges,
  isAllowedCloverRead,
  memoryTokenStore,
  nextCloverCursor,
  parseCloverCursor,
  verifyCloverWebhook,
  type CloverConnectorOptions,
  type CloverCursor,
  type CloverTokenStore,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const API_TOKEN = ["clover", "api", "test", "0".repeat(24)].join("-");
const FIRST_REFRESH = ["clover", "refresh", "test", "0"].join("-");
const CUSTOMER_KEY = ["customer", "ref", "test", "k".repeat(40)].join("-");
const NOW_MS = Date.parse("2026-01-20T00:00:00Z");
const NOW = () => new Date(NOW_MS);
const RECEIVED = "2026-01-20T00:00:00.000Z";
const BASE = `${CLOVER_MOCK_HOST}/v3/merchants/${CLOVER_TEST_MERCHANT}`;
const DAY = 86_400_000;
const FIVE_YEARS_AGO = Date.parse("2021-01-20T00:00:00Z");

const ITEM = (n: number) => cloverTestId("ITEM", n);
const ORDER = (n: number) => cloverTestId("ORD", n);
const LINE = (n: number) => cloverTestId("LI", n);

function merchant(overrides: Partial<CloverMockData> = {}): CloverMockData {
  for (const b of [cloverItem, cloverStock, cloverCustomer, cloverOrder, cloverPayment, cloverRefund]) b.reset();
  const items = cloverItem.many(3);
  // Rung up without a SKU: it gets a stand-in, the same on the item, its stock and its sales.
  delete items[2]!.sku;
  const stocks = cloverStock.many(3);
  // Oversold: Clover allows negative stock, which the inventory schema dead-letters with the record kept.
  stocks[2]!.quantity = -1;
  const orders = cloverOrder.many(4);
  orders[1]!.paymentState = "PARTIALLY_REFUNDED";
  orders[1]!.refunds = [{ id: cloverTestId("REF", 1), createdTime: cloverMs(2 * 1440 + 600), status: "SUCCESS", lineItems: { elements: [{ id: LINE(2) }] } }];
  orders[2]!.paymentState = "OPEN";
  orders[2]!.payments = [];
  // Sold from an item since deleted in Clover.
  orders[3]!.lineItems = [{ id: LINE(4), item: { id: ITEM(9) }, price: 125_400 }];
  return {
    records: {
      items,
      item_stocks: stocks,
      customers: cloverCustomer.many(2),
      orders,
      payments: cloverPayment.many(2),
      refunds: [cloverRefund.one({ id: cloverTestId("REF", 1), orderRef: { id: ORDER(2) }, payment: { id: cloverTestId("PAY", 2) } })],
    },
    apiToken: API_TOKEN,
    now: () => NOW_MS,
    ...overrides,
  };
}

/** The merchant connected with the app's OAuth tokens rather than an API token. */
function oauthMerchant(): CloverMockData {
  const { apiToken: _unused, ...rest } = merchant();
  return { ...rest, refreshToken: FIRST_REFRESH };
}

const options = (mock: CloverMock, extra: Partial<CloverConnectorOptions> = {}): CloverConnectorOptions => ({
  merchantId: CLOVER_TEST_MERCHANT,
  region: "sandbox",
  auth: { apiToken: API_TOKEN },
  customerKey: CUSTOMER_KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});
const oauth = (tokens: CloverTokenStore = memoryTokenStore(FIRST_REFRESH)) => ({ auth: { appId: CLOVER_TEST_APP, tokens } });

const connector = (mock: CloverMock, extra: Partial<CloverConnectorOptions> = {}) => cloverConnector(options(mock, extra));
const reads = (mock: CloverMock) => mock.fetch.calls.filter((c) => c.method === "GET").map((c) => decodeURIComponent(c.url.replace(BASE, "")).replace(/\+/g, " "));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const normalizer = () => cloverNormalizer({ merchantId: CLOVER_TEST_MERCHANT, customerKey: CUSTOMER_KEY });
const noSkus = () => undefined;

describe("Clover client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(cloverDocMock(merchant()));
    expect(() => cloverClient({ ...base, merchantId: "my store" })).toThrow(new CloverConfigError("CLOVER_MERCHANT_ID must be the merchant's 13-character Clover ID"));
    expect(() => cloverClient({ ...base, region: "asia" })).toThrow("CLOVER_REGION must be one of north_america, europe, latin_america, sandbox");
    expect(() => cloverClient({ ...base, region: "toString" })).toThrow(CloverConfigError);
    expect(() => cloverClient({ ...base, auth: { apiToken: " " } })).toThrow("set CLOVER_API_TOKEN, or CLOVER_APP_ID with CLOVER_REFRESH_TOKEN");
    expect(() => cloverClient({ ...base, auth: { appId: "", tokens: memoryTokenStore("x") } })).toThrow("set CLOVER_APP_ID with CLOVER_REFRESH_TOKEN, or CLOVER_API_TOKEN");
    expect(() => cloverClient({ ...base, auth: { appId: "my-app", tokens: memoryTokenStore("x") } })).toThrow("CLOVER_APP_ID must be the app's 13-character Clover ID");
    expect(() => cloverClient({ ...base, merchantId: ` ${CLOVER_TEST_MERCHANT} ` })).not.toThrow();
  });

  it("talks only to Clover's regional hosts and the sandbox", () => {
    expect(CLOVER_HOSTS).toEqual({
      north_america: "https://api.clover.com",
      europe: "https://api.eu.clover.com",
      latin_america: "https://api.la.clover.com",
      sandbox: "https://apisandbox.dev.clover.com",
    });
    for (const [region, host] of Object.entries(CLOVER_HOSTS)) expect(cloverClient({ ...options(cloverDocMock(merchant())), region }).baseUrl).toBe(host);
  });

  it("allows only its exact read paths under this merchant", () => {
    const host = CLOVER_HOSTS.sandbox;
    const ok = (path: string) => isAllowedCloverRead(host, CLOVER_TEST_MERCHANT, new URL(`${host}${path}`));
    for (const r of ["", "/orders", "/payments", "/refunds", "/items", "/item_stocks", "/customers", `/items/${ITEM(1)}`]) expect(ok(`/v3/merchants/${CLOVER_TEST_MERCHANT}${r}`), r).toBe(true);
    for (const r of [
      "/merchant",
      "/employees",
      "/orders/ORD0000000001",
      "/items/../employees",
      "/items/abc",
      `/items/${ITEM(1)}/stock`,
      "/orders/",
      "/oauth/v2/refresh",
    ]) {
      expect(ok(`/v3/merchants/${CLOVER_TEST_MERCHANT}${r}`), r).toBe(false);
    }
    expect(ok("/v3/merchants/OTHER00000000/orders")).toBe(false);
    expect(ok("/v3/apps/APPTEST00000A")).toBe(false);
    expect(isAllowedCloverRead(host, CLOVER_TEST_MERCHANT, new URL(`https://api.clover.com/v3/merchants/${CLOVER_TEST_MERCHANT}`))).toBe(false);
    expect(isAllowedCloverRead(host, CLOVER_TEST_MERCHANT, new URL(`https://user:pw@apisandbox.dev.clover.com/v3/merchants/${CLOVER_TEST_MERCHANT}`))).toBe(false);
    expect(isAllowedCloverRead(host, CLOVER_TEST_MERCHANT, new URL(`${host}/v3/merchants/${CLOVER_TEST_MERCHANT}#x`))).toBe(false);
  });

  it("refuses anything but its own reads before a request is made", async () => {
    const mock = cloverDocMock(merchant());
    const client = cloverClient(options(mock));
    await expect(client.list("employees" as never)).rejects.toThrow(new CloverConfigError("the Clover connector only reads its listed merchant paths"));
    await expect(client.list("merchant" as never)).rejects.toThrow(CloverConfigError);
    for (const filter of ["note=x", "modifiedTime>=1&filter=x", "modifiedTime>=abc", "total>1000", `modifiedTime>=${"9".repeat(16)}`, "createdTime<=5"]) {
      await expect(client.list("orders", { filters: [filter] })).rejects.toThrow("the Clover connector only filters by time");
    }
    await expect(client.list("customers", { expand: ["emailAddresses"] })).rejects.toThrow("the Clover connector doesn't expand that on customers");
    await expect(client.list("orders", { expand: ["employee"] })).rejects.toThrow(CloverConfigError);
    await expect(client.list("orders", { orderBy: "total DESC" as never })).rejects.toThrow("only orders by modifiedTime or createdTime");
    for (const limit of [0, 1001, 1.5]) await expect(client.list("orders", { limit })).rejects.toThrow("limit must be a whole number from 1 to 1000");
    await expect(client.list("orders", { offset: -1 })).rejects.toThrow("offset must be a whole number from 0");
    await expect(client.item("../employees")).rejects.toThrow("item IDs are 13-character Clover IDs");
    expect(mock.fetch.calls).toEqual([]);
  });

  it("sends GETs only, with the merchant API token as a bearer token and Clover's paging", async () => {
    const mock = cloverDocMock(merchant());
    const seen: { method: string; url: string; auth: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization") });
      return mock.fetch(request);
    };
    const client = cloverClient(options(mock, { fetch }));
    await client.merchant();
    await client.list("orders", { filters: ["modifiedTime>=1", "modifiedTime<2"], expand: ["lineItems"], orderBy: "modifiedTime ASC", offset: 3 });
    await client.item(ITEM(1));
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET", "GET"]);
    expect(seen.every((s) => s.auth === `Bearer ${API_TOKEN}`)).toBe(true);
    const url = new URL(seen[1]!.url);
    expect(url.searchParams.getAll("filter")).toEqual(["modifiedTime>=1", "modifiedTime<2"]);
    expect([url.searchParams.get("limit"), url.searchParams.get("offset"), url.searchParams.get("orderBy"), url.searchParams.get("expand")]).toEqual(["1000", "3", "modifiedTime ASC", "lineItems"]);
  });

  it("returns null for an item Clover no longer has", async () => {
    const client = cloverClient(options(cloverDocMock(merchant())));
    await expect(client.item(ITEM(9))).resolves.toBeNull();
    await expect(client.item(ITEM(1))).resolves.toMatchObject({ id: ITEM(1) });
  });

  it("refreshes OAuth tokens at the regional host, storing each new refresh token before using it", async () => {
    const mock = cloverDocMock(oauthMerchant());
    const store = memoryTokenStore(FIRST_REFRESH);
    let t = NOW_MS;
    const seen: { url: string; body: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({ url: String(input), body: String(init?.body ?? "") });
      return mock.fetch(input as string, init);
    };
    const client = cloverClient(options(mock, { ...oauth(store), fetch, clock: () => t }));
    await client.merchant();
    expect(seen[0]!.url).toBe(`${CLOVER_MOCK_HOST}/oauth/v2/refresh`);
    expect(JSON.parse(seen[0]!.body)).toEqual({ client_id: CLOVER_TEST_APP, refresh_token: FIRST_REFRESH });
    expect(store.current).toBe("clover-refresh-test-1");
    // Reused while it lasts; renewed two minutes before it expires.
    t += 27 * 60_000;
    await client.merchant();
    expect(mock.refreshes).toBe(1);
    t += 1.5 * 60_000;
    await client.merchant();
    expect([mock.refreshes, store.current]).toEqual([2, "clover-refresh-test-2"]);
    // The first refresh token is spent.
    await expect(cloverClient(options(mock, oauth())).merchant()).rejects.toThrow("Clover refused the token refresh (HTTP 401); reconnect the merchant to get a new refresh token");
  });

  it("refreshes once for reads that need a token at the same time, and once more when a token is revoked early", async () => {
    const mock = cloverDocMock(oauthMerchant());
    const store = memoryTokenStore(FIRST_REFRESH);
    const client = cloverClient(options(mock, oauth(store)));
    await Promise.all([1, 2, 3].map(() => client.merchant()));
    expect(mock.refreshes).toBe(1);
    mock.revokeAccessTokens();
    await client.merchant();
    expect(mock.refreshes).toBe(2);
    // A 401 that a fresh token doesn't fix goes to runSync.
    const always401: typeof globalThis.fetch = async (input, init) =>
      String(input).includes("/oauth/") ? mock.fetch(input as string, init) : new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 });
    const error = await failure(cloverClient(options(mock, { ...oauth(store), fetch: always401 })).merchant());
    expect(error).toBeInstanceOf(CloverApiError);
    expect(error.message).toMatch(/^Clover answered HTTP 401: 401 Unauthorized; check that the app/);
    expect(mock.refreshes).toBe(4);
  });

  it("never uses a token it couldn't store, and asks for one when there is none", async () => {
    const mock = cloverDocMock(oauthMerchant());
    const tokens: CloverTokenStore = { load: async () => FIRST_REFRESH, save: async () => Promise.reject(new Error("database down")) };
    await expect(cloverClient(options(mock, oauth(tokens))).merchant()).rejects.toThrow("database down");
    expect(mock.fetch.calls.filter((c) => c.method === "GET")).toEqual([]);
    const empty: CloverTokenStore = { load: async () => " ", save: async () => {} };
    await expect(cloverClient(options(mock, oauth(empty))).merchant()).rejects.toThrow("set CLOVER_REFRESH_TOKEN");
  });

  it("renews within the hour when Clover gives no expiry", async () => {
    let t = 0;
    let refreshes = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/oauth/")) {
        refreshes++;
        return new Response(JSON.stringify({ access_token: `a${refreshes}`, refresh_token: `r${refreshes}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: CLOVER_TEST_MERCHANT }), { status: 200 });
    };
    const client = cloverClient(options(cloverDocMock(merchant()), { ...oauth(), fetch, clock: () => t }));
    await client.merchant();
    t = 50 * 60_000;
    await client.merchant();
    t = 59 * 60_000;
    await client.merchant();
    expect(refreshes).toBe(2);
  });

  it("waits out rate limits: Clover's retry-after up to a minute, else one second doubling", async () => {
    const waits: number[] = [];
    const mock = cloverDocMock(merchant({ rateLimits: [{ retryAfter: 21 }, { retryAfter: 600 }, {}, {}] }));
    await cloverClient(options(mock, { sleep: async (ms) => void waits.push(ms) })).merchant();
    expect(waits).toEqual([21_000, 60_000, 4000, 8000]);
  });

  it("gives up after its retries, leaving the error to runSync", async () => {
    const waits: number[] = [];
    const mock = cloverDocMock(merchant({ rateLimits: Array.from({ length: 7 }, () => ({})) }));
    const error = await failure(cloverClient(options(mock, { sleep: async (ms) => void waits.push(ms) })).merchant());
    expect(error).toEqual(new CloverApiError("Clover kept rate-limiting the sync; the next run resumes from the checkpoint", 429));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("reports Clover's errors cut short and never a token", async () => {
    const answer = (status: number, body: unknown) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    const client = (fetch: typeof globalThis.fetch) => cloverClient(options(cloverDocMock(merchant()), { fetch }));
    const long = await failure(client(answer(400, { message: "x".repeat(500) })).merchant());
    expect(long.message).toBe(`Clover answered HTTP 400: ${"x".repeat(200)}`);
    expect(long.message).not.toContain(API_TOKEN);
    const forbidden = await failure(client(answer(403, { error: { message: "Forbidden" } })).merchant());
    expect(forbidden.message).toContain("Forbidden; check that the app (or API token) has the Read merchant, orders, payments, inventory and customers permissions");
    await expect(client(answer(500, "<html>")).merchant()).rejects.toThrow(/^Clover answered HTTP 500$/);
    await expect(client(answer(200, "not json")).merchant()).rejects.toThrow("Clover did not answer with JSON");
    await expect(client(answer(200, { elements: "no" })).list("orders")).rejects.toThrow("Clover's orders answer has no elements");
  });
});

describe("Clover normalization", () => {
  it("turns a paid order into order.updated and sale.completed in Shopify's shapes, keeping no free text", () => {
    cloverOrder.reset();
    const order = cloverOrder.one();
    const events = normalizer().orderEvents(
      {
        ...order,
        customers: { elements: [{ id: cloverTestId("CUST", 1), firstName: "Test", lastName: "Customer 1" }] },
        lineItems: { elements: [{ id: LINE(1), item: { id: ITEM(1) }, price: 125_100, discounts: { elements: [{ amount: -5000 }] } }] },
        payments: { elements: [{ id: cloverTestId("PAY", 1), amount: 120_100, result: "SUCCESS", tender: { labelKey: "com.clover.tender.credit_card" } }] },
      },
      RECEIVED,
      (id) => (id === ITEM(1) ? "SKU-TEST-0001" : undefined),
    );
    const customerId = normalizer().customerRef(cloverTestId("CUST", 1));
    expect(events).toEqual([
      {
        id: `clover_order:${ORDER(1)}:${order.modifiedTime}`,
        type: "order.updated",
        occurredAt: cloverTime(order.modifiedTime),
        receivedAt: RECEIVED,
        idempotencyKey: `clover:order:${ORDER(1)}:${order.modifiedTime}`,
        payload: {
          orderId: `clover:order:${ORDER(1)}`,
          createdAt: cloverTime(order.createdTime),
          financialStatus: "PAID",
          state: "locked",
          channel: "store",
          currency: "USD",
          totalCents: 125_100,
          lineCount: 1,
          linesComplete: true,
          customerId,
        },
      },
      {
        id: `clover_sale:${ORDER(1)}`,
        type: "sale.completed",
        occurredAt: cloverTime(order.clientCreatedTime),
        receivedAt: RECEIVED,
        idempotencyKey: `clover:sale:${ORDER(1)}`,
        payload: {
          saleId: `clover:order:${ORDER(1)}`,
          customerId,
          channel: "store",
          lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 125_100, discountCents: 5000 }],
          totalCents: 125_100,
          payments: [{ method: "card", amountCents: 120_100 }],
        },
      },
    ]);
    const text = JSON.stringify(events);
    for (const kept of ["Synthetic", "Test Customer", "Customer 1", "firstName"]) expect(text).not.toContain(kept);
  });

  it("makes each refund of order lines a sale.returned, and skips voided, failed and amount-only refunds", () => {
    const events = normalizer().orderEvents(
      {
        id: ORDER(5),
        total: 300_000,
        paymentState: "PARTIALLY_REFUNDED",
        createdTime: cloverMs(10),
        modifiedTime: cloverMs(20),
        lineItems: {
          elements: [
            { id: LINE(1), item: { id: ITEM(1) }, price: 100_000, discounts: { elements: [{ percentage: 10 }] } },
            { id: LINE(2), price: 200_000 },
          ],
        },
        refunds: {
          elements: [
            { id: cloverTestId("REF", 1), createdTime: cloverMs(30), lineItems: { elements: [{ id: LINE(1) }, { id: LINE(9) }] } },
            { id: cloverTestId("REF", 2), createdTime: cloverMs(31), voided: true, lineItems: { elements: [{ id: LINE(2) }] } },
            { id: cloverTestId("REF", 3), createdTime: cloverMs(32), status: "FAIL", lineItems: { elements: [{ id: LINE(2) }] } },
            { id: cloverTestId("REF", 4), createdTime: cloverMs(33) },
            { id: "bad" },
          ],
        },
      },
      RECEIVED,
      noSkus,
    );
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.completed", "sale.returned"]);
    const sale = events[1]!.payload;
    // A line without an item is a custom amount; with no payments listed the sale is one "other" tender.
    expect(sale.lines).toEqual([
      { sku: `clover-item-${ITEM(1)}`, quantity: 1, unitPriceCents: 100_000, discountCents: 10_000 },
      { sku: `clover-line-${LINE(2)}`, quantity: 1, unitPriceCents: 200_000, discountCents: 0 },
    ]);
    expect(sale.payments).toEqual([{ method: "other", amountCents: 300_000 }]);
    expect(events[2]).toMatchObject({
      idempotencyKey: `clover:refund:${cloverTestId("REF", 1)}`,
      occurredAt: cloverTime(cloverMs(30)),
      payload: { saleId: `clover:order:${ORDER(5)}`, returnId: `clover:refund:${cloverTestId("REF", 1)}`, lines: [{ sku: `clover-item-${ITEM(1)}`, quantity: 1, refundCents: 90_000 }] },
    });
  });

  it("gives no sale for an unpaid, unpriced, free or incomplete order, but still records its state", () => {
    const n = normalizer();
    const base = { id: ORDER(1), total: 1000, paymentState: "PAID", createdTime: cloverMs(1), modifiedTime: cloverMs(2), lineItems: { elements: [{ id: LINE(1), price: 1000 }] } };
    const sales = (o: Record<string, unknown>) => n.orderEvents(o, RECEIVED, noSkus).filter((e) => e.type === "sale.completed").length;
    expect(sales(base)).toBe(1);
    expect(sales({ ...base, paymentState: "OPEN" })).toBe(0);
    expect(sales({ ...base, total: 0 })).toBe(0);
    expect(sales({ ...base, lineItems: { elements: [{ id: LINE(1), price: "10.00" }] } })).toBe(0);
    expect(sales({ ...base, lineItems: { elements: [] } })).toBe(0);
    // Clover returns at most 100 nested lines, so a 100-line order may be missing some.
    const hundred = { elements: Array.from({ length: 100 }, (_, i) => ({ id: cloverTestId("LI", i + 1), price: 10 })) };
    const big = n.orderEvents({ ...base, lineItems: hundred }, RECEIVED, noSkus);
    expect(big.map((e) => e.type)).toEqual(["order.updated"]);
    expect(big[0]!.payload).toMatchObject({ lineCount: 100, linesComplete: false });
    const ninetyNine = { elements: hundred.elements.slice(1) };
    expect(n.orderEvents({ ...base, lineItems: ninetyNine }, RECEIVED, noSkus)[0]!.payload).toMatchObject({ lineCount: 99, linesComplete: true });
    expect(n.orderEvents({ id: "not-an-id" }, RECEIVED, noSkus)).toEqual([]);
    // No modified time: no occurredAt, so the pipeline dead-letters it with the record kept.
    expect(n.orderEvents({ id: ORDER(1) }, RECEIVED, noSkus)[0]).toMatchObject({ occurredAt: undefined, idempotencyKey: `clover:order:${ORDER(1)}:unknown` });
  });

  it("reads quantities sold by count or weight, which Clover gives in thousandths", () => {
    const sale = (line: Record<string, unknown>) =>
      normalizer().orderEvents({ id: ORDER(1), total: 1, paymentState: "PAID", modifiedTime: cloverMs(1), lineItems: { elements: [{ id: LINE(1), ...line }] } }, RECEIVED, noSkus)[1]?.payload.lines;
    expect(sale({ price: 2500, unitQty: 3000 })).toEqual([{ sku: `clover-line-${LINE(1)}`, quantity: 3, unitPriceCents: 2500, discountCents: 0 }]);
    expect(sale({ price: 10_000, unitQty: 1250 })).toEqual([{ sku: `clover-line-${LINE(1)}`, quantity: 1, unitPriceCents: 12_500, discountCents: 0 }]);
    expect(sale({ price: 10_000, unitQty: 0 })).toEqual([{ sku: `clover-line-${LINE(1)}`, quantity: 1, unitPriceCents: 10_000, discountCents: 0 }]);
  });

  it("keeps a payment as Stripe's payment.charge_updated, with at most the card type and last four digits", () => {
    cloverPayment.reset();
    const payment = cloverPayment.one({ refunds: { elements: [{ id: cloverTestId("REF", 1), amount: 4000 }] } as never });
    const [event] = normalizer().paymentEvents(payment, RECEIVED);
    expect(event).toEqual({
      id: `clover_payment:${cloverTestId("PAY", 1)}:${payment.modifiedTime}`,
      type: "payment.charge_updated",
      occurredAt: cloverTime(payment.modifiedTime),
      receivedAt: RECEIVED,
      idempotencyKey: `clover:payment:${cloverTestId("PAY", 1)}:${payment.modifiedTime}`,
      payload: {
        chargeId: `clover:payment:${cloverTestId("PAY", 1)}`,
        status: "success",
        paid: true,
        captured: true,
        amountCents: 125_100,
        tipCents: 0,
        taxCents: 0,
        refundedCents: 4000,
        currency: "usd",
        disputed: false,
        method: "card",
        cardBrand: "VISA",
        cardLast4: "0002",
        offline: false,
        orderId: `clover:order:${ORDER(1)}`,
      },
    });
    const text = JSON.stringify(event);
    for (const dropped of ['"400000"', "first6", "Test Customer", "card-token-test", "TEST01", "REF-TEST", "EMV"]) expect(text, dropped).not.toContain(dropped);
    expect(cardSummary({ cardType: "<script>", last4: "12345", first6: "400000" })).toEqual({ cardType: "OTHER", last4: null });
    expect(cardSummary(null)).toBeNull();
    const failed = normalizer().paymentEvents({ id: cloverTestId("PAY", 2), result: "FAIL", createdTime: cloverMs(1) }, RECEIVED)[0]!;
    expect(failed.payload).toMatchObject({ status: "fail", paid: false, captured: false, method: "other", cardBrand: null, cardLast4: null });
    expect(failed.occurredAt).toBe(cloverTime(cloverMs(1)));
    expect(normalizer().paymentEvents({ id: 5 }, RECEIVED)).toEqual([]);
  });

  it("keeps a refund as Stripe's payment.refund_updated, a new version when it is voided", () => {
    cloverRefund.reset();
    const refund = cloverRefund.one();
    const [event] = normalizer().refundEvents(refund, RECEIVED);
    expect(event).toMatchObject({
      type: "payment.refund_updated",
      idempotencyKey: `clover:refund_payment:${cloverTestId("REF", 1)}:success`,
      occurredAt: cloverTime(refund.createdTime),
      payload: { refundId: `clover:refund:${cloverTestId("REF", 1)}`, chargeId: `clover:payment:${cloverTestId("PAY", 1)}`, orderId: `clover:order:${ORDER(1)}`, amountCents: 40_000, status: "success" },
    });
    expect(normalizer().refundEvents({ ...refund, voided: true }, RECEIVED)[0]!.idempotencyKey).toBe(`clover:refund_payment:${cloverTestId("REF", 1)}:voided`);
    expect(normalizer().refundEvents({ id: "x" }, RECEIVED)).toEqual([]);
  });

  it("makes items Shopify product.updated events and stock POS inventory.counted ones, with one SKU throughout", () => {
    cloverItem.reset();
    const item = cloverItem.one({ itemStock: { quantity: 3 } } as never);
    const [product] = normalizer().itemEvents(item, RECEIVED);
    expect(product).toMatchObject({
      type: "product.updated",
      idempotencyKey: `clover:item:${ITEM(1)}:${item.modifiedTime}`,
      payload: {
        productId: `clover:item:${ITEM(1)}`,
        title: "Test 14K ring 1",
        status: "ACTIVE",
        costCents: 60_000,
        variants: [{ variantId: `clover:item:${ITEM(1)}`, sku: "SKU-TEST-0001", priceCents: 125_100, inventoryQuantity: 3 }],
      },
    });
    expect(normalizer().itemEvents({ id: ITEM(2), hidden: true, sku: " " }, RECEIVED)[0]!.payload).toMatchObject({ status: "HIDDEN", title: `Clover item ${ITEM(2)}`, variants: [{ sku: `clover-item-${ITEM(2)}` }] });
    expect(normalizer().itemEvents({ id: ITEM(2), deleted: true }, RECEIVED)[0]!.payload.status).toBe("DELETED");
    const [count] = normalizer().stockEvents({ item: { id: ITEM(1) }, quantity: 2 }, RECEIVED, () => "SKU-TEST-0001");
    expect(count).toEqual({
      id: `clover_count:${ITEM(1)}:2026-01-20:2`,
      type: "inventory.counted",
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: `clover:count:${ITEM(1)}:2026-01-20:2`,
      payload: { sku: "SKU-TEST-0001", onHand: 2 },
    });
    expect(normalizer().stockEvents({ item: { id: ITEM(3) }, stockCount: 4 }, RECEIVED, noSkus)[0]!.payload).toEqual({ sku: `clover-item-${ITEM(3)}`, onHand: 4 });
    expect(normalizer().stockEvents({ item: {} }, RECEIVED, noSkus)).toEqual([]);
  });

  it("keeps a customer only as a reference keyed with CUSTOMER_REF_KEY, and their marketing choice", () => {
    cloverCustomer.reset();
    const customer = cloverCustomer.one();
    const [event] = normalizer().customerEvents(customer, RECEIVED);
    const ref = event!.payload.customerId as string;
    expect(ref).toMatch(new RegExp(`^${CLOVER_CUSTOMER_REF_PREFIX}[0-9a-f]{32}$`));
    expect(event!.payload).toEqual({ customerId: ref, name: "Clover customer", marketingConsent: true });
    const text = JSON.stringify(event);
    for (const dropped of [customer.id as string, "Test", "example.test", "555", "Test Street"]) expect(text, dropped).not.toContain(dropped);
    // Keyed: another instance's key gives another reference, and a plain hash of the ID doesn't find it.
    const other = cloverNormalizer({ merchantId: CLOVER_TEST_MERCHANT, customerKey: `${CUSTOMER_KEY}-other` }).customerRef(customer.id as string);
    expect(other).not.toBe(ref);
    for (const plain of [customer.id as string, `clover:customer:v1:${CLOVER_TEST_MERCHANT}:${customer.id}`]) {
      expect(ref).not.toContain(createHash("sha256").update(plain).digest("hex").slice(0, 32));
    }
    // Another merchant's customer with the same ID is someone else.
    expect(cloverNormalizer({ merchantId: "MOTHER000000A", customerKey: CUSTOMER_KEY }).customerRef(customer.id as string)).not.toBe(ref);
    // A changed choice is a new event; the same record again is a duplicate.
    expect(normalizer().customerEvents({ ...customer, marketingAllowed: false }, RECEIVED)[0]!.idempotencyKey).not.toBe(event!.idempotencyKey);
    expect(normalizer().customerEvents({ ...customer, firstName: "Renamed" }, RECEIVED)[0]!.idempotencyKey).toBe(event!.idempotencyKey);
    // Consent is never assumed.
    expect(normalizer().customerEvents({ id: customer.id }, RECEIVED)[0]!.payload.marketingConsent).toBe(false);
    expect(normalizer().customerEvents({ id: "nope" }, RECEIVED)).toEqual([]);
    expect(() => cloverNormalizer({ merchantId: CLOVER_TEST_MERCHANT, customerKey: "short" })).toThrow(CloverCustomerKeyError);
    expect(() => cloverNormalizer({ merchantId: CLOVER_TEST_MERCHANT, customerKey: undefined as never })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("maps Clover tenders to the sales department's payment methods", () => {
    expect(cloverPaymentMethod("com.clover.tender.credit_card")).toBe("card");
    expect(cloverPaymentMethod("com.clover.tender.debit_card")).toBe("card");
    expect(cloverPaymentMethod("com.clover.tender.cash")).toBe("cash");
    expect(cloverPaymentMethod("com.clover.tender.check")).toBe("check");
    expect(cloverPaymentMethod("com.clover.tender.external_gift_card")).toBe("gift_card");
    expect(cloverPaymentMethod(undefined, "Synchrony financing")).toBe("financing");
    expect(cloverPaymentMethod("com.clover.tender.external_payment", "Store credit")).toBe("other");
    expect(cloverPaymentMethod(5)).toBe("other");
  });

  it("reads epoch milliseconds, and nothing else, as times", () => {
    expect(cloverTime(1_767_225_600_000)).toBe("2026-01-01T00:00:00.000Z");
    for (const bad of [0, -1, 1.5, "1767225600000", 1e15, null, undefined]) expect(cloverTime(bad)).toBeUndefined();
  });

  it("uses synthetic fixtures only, with no millisecond time that looks like a card number", () => {
    const data = merchant();
    assertSynthetic(data.records);
    assertSynthetic(JSON.stringify(data.records));
    expect(notCardLike(4_222_222_222_222)).toBe(4_222_222_222_223);
    expect(() => assertSynthetic(String(4_222_222_222_222))).toThrow();
  });

  it("stays fast on hostile input", () => {
    const hostile = `${"a:".repeat(50_000)}${"1".repeat(50_000)}`;
    const started = performance.now();
    cloverPaymentMethod(hostile, hostile);
    cardSummary({ cardType: hostile, last4: hostile });
    verifyCloverWebhook("code", hostile);
    cloverVerificationCode({ verificationCode: hostile });
    cloverWebhookChanges({ merchants: { [CLOVER_TEST_MERCHANT]: [{ objectId: hostile, type: hostile, ts: 1 }] } }, { merchantId: CLOVER_TEST_MERCHANT, now: NOW_MS });
    normalizer().orderEvents({ id: hostile, title: hostile }, RECEIVED, noSkus);
    normalizer().itemEvents({ id: ITEM(1), name: hostile, sku: hostile }, RECEIVED);
    expect(() => parseCloverCursor(hostile)).toThrow();
    expect(() => cloverClient(options(cloverDocMock(merchant()), { merchantId: hostile }))).toThrow(CloverConfigError);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("Clover sync", () => {
  // 3 items, 3 stock counts, 2 customers; orders: 2 sales with their state, one with a return, an open order,
  // and a sale of a since-deleted item (4 order.updated, 3 sale.completed, 1 sale.returned); 2 payments; 1 refund.
  const EXPECTED = 3 + 3 + 2 + 8 + 2 + 1;
  const WINDOWS = Math.ceil((NOW_MS - FIVE_YEARS_AGO) / CLOVER_WINDOW_MS);

  it("imports, replays, resumes and retries the mocked merchant", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(cloverDocMock(merchant())), expected: { ingested: EXPECTED } });
    expect(result.full.batches).toBe(3 + 3 * WINDOWS);
    expect(parseCloverCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", offset: 0, nextFrom: NOW_MS - CLOVER_OVERLAP_MS });
  });

  it("reads the merchant, then each stream five years back, orders, payments and refunds 89 days at a time", async () => {
    const mock = cloverDocMock(merchant());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const all = reads(mock);
    const page = "limit=1000&offset=0";
    expect(all.slice(0, 4)).toEqual(["", `/items?filter=modifiedTime>=0&filter=modifiedTime<${NOW_MS}&orderBy=modifiedTime ASC&${page}`, `/item_stocks?${page}`, `/customers?${page}`]);
    // The sold item Clover no longer has is looked up once; the items read already need no lookup.
    expect(all.filter((r) => r.startsWith("/items/"))).toEqual([`/items/${ITEM(9)}`]);
    const window = (stream: string, field: string, from: number, expand: string) =>
      `/${stream}?filter=${field}>=${from}&filter=${field}<${Math.min(from + CLOVER_WINDOW_MS, NOW_MS)}&expand=${expand}&orderBy=${field} ASC&${page}`;
    const orders = all.filter((r) => r.startsWith("/orders"));
    expect(orders).toHaveLength(WINDOWS);
    expect(orders[0]).toBe(window("orders", "modifiedTime", FIVE_YEARS_AGO, "lineItems,lineItems.discounts,payments,refunds,customers"));
    expect(orders.at(-1)).toBe(window("orders", "modifiedTime", FIVE_YEARS_AGO + (WINDOWS - 1) * CLOVER_WINDOW_MS, "lineItems,lineItems.discounts,payments,refunds,customers"));
    expect(all.filter((r) => r.startsWith("/payments"))[0]).toBe(window("payments", "modifiedTime", FIVE_YEARS_AGO, "tender,cardTransaction,refunds"));
    expect(all.filter((r) => r.startsWith("/refunds"))[0]).toBe(window("refunds", "createdTime", FIVE_YEARS_AGO, "payment"));
    expect(mock.fetch.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("reaches orders older than Clover's 90-day cap, and none from before the history starts", async () => {
    const data = merchant();
    const old = (n: number, at: number) => cloverOrder.one({ id: ORDER(n), createdTime: notCardLike(at), clientCreatedTime: notCardLike(at), modifiedTime: notCardLike(at + 1000) });
    data.records.orders = [old(10, NOW_MS - 200 * DAY), old(11, NOW_MS - 4 * 365 * DAY), old(12, FIVE_YEARS_AGO - DAY)];
    data.records.payments = [];
    data.records.refunds = [];
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(cloverDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const sales = memory.events.filter((e) => e.type === "sale.completed").map((e) => (e.payload as { saleId: string }).saleId);
    expect(sales.sort()).toEqual([`clover:order:${ORDER(10)}`, `clover:order:${ORDER(11)}`]);
  });

  it("pages 1000 at a time from the last time read, so records changed mid-pass can't make it skip one", async () => {
    const data = merchant();
    // 2500 items, many changed in the same millisecond.
    data.records.items = Array.from({ length: 2500 }, (_, i) => ({ id: cloverTestId("ITEM", 100 + i), name: "Test ring", sku: `SKU-TEST-${i}`, price: 100, modifiedTime: notCardLike(cloverMs(1)) + Math.floor(i / 700) }));
    const mock = cloverDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const items = reads(mock).filter((r) => r.startsWith("/items?"));
    expect(items).toHaveLength(3);
    // The second page starts at the last item's time, skipping the 300 already read at that time.
    const t = (data.records.items[999]!.modifiedTime as number);
    expect(items[1]).toBe(`/items?filter=modifiedTime>=${t}&filter=modifiedTime<${NOW_MS}&orderBy=modifiedTime ASC&limit=1000&offset=300`);
    expect(memory.events.filter((e) => e.type === "product.updated")).toHaveLength(2500);
    expect(report.duplicates).toBe(0);
  });

  it("moves the window or offset on correctly at a full page", () => {
    const cursor: CloverCursor = { pass: "incremental", step: "orders", since: 100, until: 1000, nextFrom: 900, from: 100, to: 1000, offset: 0 };
    const page = (times: number[]) => times.map((modifiedTime) => ({ modifiedTime }));
    const full = (t: number) => page(Array.from({ length: CLOVER_PAGE_SIZE }, (_, i) => (i < 600 ? 200 : t)));
    expect(nextCloverCursor(cursor, full(300))).toMatchObject({ step: "orders", from: 300, offset: 400 });
    // Every record at the window's start: read on by offset.
    expect(nextCloverCursor({ ...cursor, offset: 7 }, page(Array(CLOVER_PAGE_SIZE).fill(100)))).toMatchObject({ from: 100, offset: 1007 });
    // A time outside the window (Clover ignoring the filter) falls back to the offset.
    expect(nextCloverCursor(cursor, full(5000))).toMatchObject({ from: 100, offset: 1000 });
    expect(nextCloverCursor(cursor, page([1, 2]))).toMatchObject({ step: "payments", from: 100, to: 1000, offset: 0 });
    expect(nextCloverCursor({ ...cursor, step: "customers" }, page(Array(CLOVER_PAGE_SIZE).fill(1)))).toMatchObject({ step: "customers", offset: 1000 });
    expect(nextCloverCursor({ ...cursor, step: "customers", offset: 1000 }, [])).toMatchObject({ step: "orders", from: 100, to: 1000, offset: 0 });
    expect(nextCloverCursor({ ...cursor, step: "refunds" }, [])).toMatchObject({ step: "done" });
  });

  it("produces payloads the retail departments accept, dead-lettering only an oversold count", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(cloverDocMock(merchant())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: EXPECTED - 1, deadLettered: 1 });
    expect(memory.deadLetters.map((d) => (d.raw as { type?: string }).type)).toEqual(["inventory.counted"]);
    const types = memory.events.map((e) => e.type);
    expect(new Set(types)).toEqual(new Set(["product.updated", "inventory.counted", "customer.profile_updated", "order.updated", "sale.completed", "sale.returned", "payment.charge_updated", "payment.refund_updated"]));
    // The deleted item's sale carries a stand-in SKU; the item without one carries the same stand-in on its sale, stock and product.
    const lines = memory.events.filter((e) => e.type === "sale.completed").flatMap((e) => (e.payload as { lines: { sku: string }[] }).lines.map((l) => l.sku));
    expect(lines).toEqual(["SKU-TEST-0001", "SKU-TEST-0002", `clover-item-${ITEM(9)}`]);
    const stockSkus = memory.events.filter((e) => e.type === "inventory.counted").map((e) => (e.payload as { sku: string }).sku);
    expect(stockSkus).toEqual(["SKU-TEST-0001", "SKU-TEST-0002"]);
    // Nothing personal reached the store.
    const stored = JSON.stringify(memory.events);
    for (const dropped of ["example.test", "Test Customer", "Test Street", "Synthetic", "first6", "cardholderName", "card-token-test", "Customer 1", "firstName"]) expect(stored, dropped).not.toContain(dropped);
    assertSynthetic(memory.events);
  });

  it("looks up the SKU of a sold item it hasn't read yet, once per item", async () => {
    const data = merchant();
    data.records.orders = [cloverOrder.one({ id: ORDER(20) }), cloverOrder.one({ id: ORDER(21) })].map((o) => ({ ...o, lineItems: [{ id: LINE(20), item: { id: ITEM(2) }, price: 100 }] }));
    const mock = cloverDocMock(data);
    const saved: CloverCursor = { pass: "incremental", step: "orders", since: NOW_MS - 30 * DAY, until: NOW_MS, nextFrom: NOW_MS - CLOVER_OVERLAP_MS, from: NOW_MS - 30 * DAY, to: NOW_MS, offset: 0 };
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) })) batches.push(b);
    expect(reads(mock).filter((r) => r.startsWith("/items/"))).toEqual([`/items/${ITEM(2)}`]);
    const sale = batches.flatMap((b) => b.events as { type: string; payload: { lines?: { sku: string }[] } }[]).find((e) => e.type === "sale.completed");
    expect(sale!.payload.lines![0]!.sku).toBe("SKU-TEST-0002");
  });

  it("stops before importing anything when the token answers for another merchant", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ id: "MOTHER000000A" }), { status: 200 });
    const batches = connector(cloverDocMock(merchant()), { fetch }).historicalImport({ organizationId: TEST_ORG, cursor: null });
    await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("the Clover token answered for a different merchant than CLOVER_MERCHANT_ID");
  });

  it("leaves a finished import finished", async () => {
    const done: CloverCursor = { pass: "historical", step: "done", since: FIVE_YEARS_AGO, until: NOW_MS, nextFrom: NOW_MS, from: FIVE_YEARS_AGO, to: FIVE_YEARS_AGO, offset: 0 };
    const mock = cloverDocMock(merchant());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("reads changes since the last pass started, looking back 48 hours without a checkpoint", async () => {
    const data = merchant();
    data.records.items![0]!.modifiedTime = notCardLike(NOW_MS - 3600_000);
    const mock = cloverDocMock(data);
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const since = NOW_MS - 48 * 3_600_000;
    expect(reads(mock)).toContain(`/items?filter=modifiedTime>=${since}&filter=modifiedTime<${NOW_MS}&orderBy=modifiedTime ASC&limit=1000&offset=0`);
    expect(reads(mock).filter((r) => r.startsWith("/orders"))).toEqual([
      `/orders?filter=modifiedTime>=${since}&filter=modifiedTime<${NOW_MS}&expand=lineItems,lineItems.discounts,payments,refunds,customers&orderBy=modifiedTime ASC&limit=1000&offset=0`,
    ]);
    expect(memory.events.filter((e) => e.type === "product.updated")).toHaveLength(1);
    expect(parseCloverCursor(first.cursor)).toMatchObject({ pass: "incremental", step: "done", nextFrom: NOW_MS - CLOVER_OVERLAP_MS });

    // The next pass starts where this one said, a little before it began.
    const later = () => new Date(NOW_MS + DAY);
    const mock2 = cloverDocMock({ ...data, now: () => NOW_MS + DAY });
    await runSync({ connector: connector(mock2, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Five minutes before the previous pass began, so a change saved while it ran is read again rather than missed.
    expect(reads(mock2)[1]).toBe(`/items?filter=modifiedTime>=${NOW_MS - 5 * 60_000}&filter=modifiedTime<${NOW_MS + DAY}&orderBy=modifiedTime ASC&limit=1000&offset=0`);
  });

  it("stops at a lasting rate limit with the checkpoint where it was, and carries on from there", async () => {
    const data = merchant();
    const { memory, pipeline } = testPipeline();
    // The merchant, items and item stocks read, then Clover keeps answering 429.
    let calls = 0;
    const mock = cloverDocMock(data);
    const limited: typeof globalThis.fetch = async (input, init) => (++calls > 3 ? new Response("{}", { status: 429 }) : mock.fetch(input as string, init));
    const error = await failure(runSync({ connector: connector(mock, { fetch: limited, rateLimitRetries: 0 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 1, sleep: async () => {} }));
    expect(error.message).toContain("Clover kept rate-limiting the sync");
    const checkpoint = parseCloverCursor(await memory.getCheckpoint(TEST_ORG, "clover", "historical"));
    expect(checkpoint).toMatchObject({ pass: "historical", step: "customers", offset: 0 });
    const before = memory.events.length;
    const resumed = await runSync({ connector: connector(cloverDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(resumed.duplicates).toBe(0);
    expect(before + resumed.ingested).toBe(EXPECTED);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: CloverCursor = { pass: "incremental", step: "orders", since: 1, until: 10, nextFrom: 5, from: 1, to: 10, offset: 0 };
    expect(parseCloverCursor(JSON.stringify(good))).toEqual(good);
    expect(parseCloverCursor(null)).toBeNull();
    for (const bad of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...good, pass: "full" }),
      JSON.stringify({ ...good, step: "employees" }),
      JSON.stringify({ ...good, offset: -1 }),
      JSON.stringify({ ...good, offset: 1.5 }),
      JSON.stringify({ ...good, since: "1" }),
      JSON.stringify({ ...good, since: 11 }),
      JSON.stringify({ ...good, from: 11, to: 10 }),
      JSON.stringify({ ...good, to: 11 }),
      JSON.stringify({ ...good, nextFrom: 1e15 }),
      JSON.stringify({ ...good, from: -1 }),
    ]) {
      expect(() => parseCloverCursor(bad), bad).toThrow("Clover checkpoint is not in the expected shape");
    }
  });

  it("builds filters only from its own times", () => {
    const cursor: CloverCursor = { pass: "historical", step: "refunds", since: 1, until: 10, nextFrom: 5, from: 2, to: 9, offset: 4 };
    expect(cloverPageRequest(cursor)).toEqual({ limit: 1000, offset: 4, orderBy: "createdTime ASC", filters: ["createdTime>=2", "createdTime<9"], expand: ["payment"] });
    expect(cloverPageRequest({ ...cursor, step: "customers" })).toEqual({ limit: 1000, offset: 4 });
    expect(cloverPageRequest({ ...cursor, step: "items" })).toEqual({ limit: 1000, offset: 4, orderBy: "modifiedTime ASC", filters: ["modifiedTime>=2", "modifiedTime<9"] });
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(cloverDocMock(merchant()));
    expect(c.writes).toBe(CLOVER_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => a.action)).toEqual(["adjust_stock", "update_item"]);
  });
});

describe("Clover webhooks", () => {
  const AUTH = ["clover", "auth", "test", "0".repeat(28)].join("-");
  const at = (minutesAgo: number) => NOW_MS - minutesAgo * 60_000;
  const body = (entries: unknown[], extra: Record<string, unknown> = {}) => ({ appId: CLOVER_TEST_APP, merchants: { [CLOVER_TEST_MERCHANT]: entries, MOTHER000000A: [{ objectId: `O:${ORDER(9)}`, type: "UPDATE", ts: at(1) }] }, ...extra });
  const opts = { merchantId: CLOVER_TEST_MERCHANT, appId: CLOVER_TEST_APP, now: NOW_MS };

  it("accepts the app's auth code and nothing else, comparing in constant time", () => {
    expect(verifyCloverWebhook(AUTH, AUTH)).toEqual({ ok: true });
    expect(verifyCloverWebhook(AUTH, ` ${AUTH} `)).toEqual({ ok: true });
    expect(verifyCloverWebhook(AUTH, `${AUTH}x`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyCloverWebhook(AUTH, AUTH.slice(0, -1))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyCloverWebhook(AUTH, AUTH.toUpperCase())).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyCloverWebhook(AUTH, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyCloverWebhook(AUTH, "")).toEqual({ ok: false, reason: "missing" });
    expect(verifyCloverWebhook(AUTH, "x".repeat(300))).toEqual({ ok: false, reason: "missing" });
    expect(verifyCloverWebhook("", AUTH)).toEqual({ ok: false, reason: "missing" });
    expect(verifyCloverWebhook(" ", " ")).toEqual({ ok: false, reason: "missing" });
  });

  it("reads the one-off verification code, and nothing else, from the verification POST", () => {
    const code = "00000000-0000-4000-8000-000000000000";
    expect(cloverVerificationCode({ verificationCode: code })).toBe(code);
    expect(cloverVerificationCode({ verificationCode: code, merchants: {} })).toBeNull();
    expect(cloverVerificationCode({ verificationCode: "<script>" })).toBeNull();
    expect(cloverVerificationCode({ verificationCode: 5 })).toBeNull();
    expect(cloverVerificationCode([code])).toBeNull();
    expect(cloverVerificationCode(null)).toBeNull();
  });

  it("lists this merchant's order, payment, item, stock and customer changes inside the replay window", () => {
    const changes = cloverWebhookChanges(
      body([
        { objectId: `O:${ORDER(1)}`, type: "CREATE", ts: at(1) },
        { objectId: `P:${cloverTestId("PAY", 1)}`, type: "UPDATE", ts: at(2) },
        { objectId: `I:${ITEM(1)}`, type: "DELETE", ts: at(3) },
        { objectId: `IS:${ITEM(1)}`, type: "UPDATE", ts: at(3) },
        { objectId: `C:${cloverTestId("CUST", 1)}`, type: "UPDATE", ts: at(4) },
        { objectId: `E:${cloverTestId("EMP", 1)}`, type: "UPDATE", ts: at(1) },
        { objectId: `O:../x`, type: "UPDATE", ts: at(1) },
        { objectId: `O:${ORDER(2)}`, type: "PATCH", ts: at(1) },
        { objectId: `O:${ORDER(3)}`, type: "UPDATE", ts: at(25 * 60) },
        { objectId: `O:${ORDER(4)}`, type: "UPDATE", ts: at(-10) },
        { objectId: `O:${ORDER(5)}`, type: "UPDATE", ts: "yesterday" },
        { objectId: `toString:${ORDER(6)}`, type: "UPDATE", ts: at(1) },
        { objectId: ORDER(7), type: "UPDATE", ts: at(1) },
        null,
      ]),
      opts,
    );
    expect(changes.map((c) => [c.stream, c.id, c.operation])).toEqual([
      ["orders", ORDER(1), "create"],
      ["payments", cloverTestId("PAY", 1), "update"],
      ["items", ITEM(1), "delete"],
      ["item_stocks", ITEM(1), "update"],
      ["customers", cloverTestId("CUST", 1), "update"],
    ]);
    expect(changes[0]!.key).toBe(`${CLOVER_TEST_MERCHANT}:O:${ORDER(1)}:CREATE:${at(1)}`);
    expect(cloverWebhookChanges(body([{ objectId: `O:${ORDER(3)}`, type: "UPDATE", ts: at(25 * 60) }]), { ...opts, replayWindowMs: 2 * CLOVER_REPLAY_WINDOW_MS })).toHaveLength(1);
    expect(cloverWebhookChanges(body([{ objectId: `O:${ORDER(1)}`, type: "UPDATE", ts: at(1) }], { appId: "OTHERAPP0000A" }), opts)).toEqual([]);
    expect(cloverWebhookChanges({ merchants: { toString: [] } }, { merchantId: "toString", now: NOW_MS })).toEqual([]);
    for (const junk of [null, [], { merchants: [] }, { merchants: { [CLOVER_TEST_MERCHANT]: "x" } }, { appId: CLOVER_TEST_APP }]) expect(cloverWebhookChanges(junk, opts)).toEqual([]);
  });

  it("counts a replayed notification once", () => {
    const deduper = new CloverWebhookDeduper(3);
    const changes = cloverWebhookChanges(body([{ objectId: `O:${ORDER(1)}`, type: "UPDATE", ts: at(1) }, { objectId: `O:${ORDER(1)}`, type: "UPDATE", ts: at(2) }]), opts);
    expect(deduper.fresh(changes)).toHaveLength(2);
    expect(deduper.fresh(changes)).toEqual([]);
    expect(deduper.fresh([...changes, ...changes])).toEqual([]);
    // Bounded: the oldest are forgotten, and the replay window keeps them out anyway.
    const more = cloverWebhookChanges(body([1, 2, 3].map((n) => ({ objectId: `O:${ORDER(10 + n)}`, type: "UPDATE", ts: at(1) }))), opts);
    expect(deduper.fresh(more)).toHaveLength(3);
    expect(deduper.fresh(changes)).toHaveLength(2);
  });

  it("treats a notification as a prompt to sync, which stores nothing twice", async () => {
    const mock = cloverDocMock(merchant());
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    await memory.saveCheckpoint(TEST_ORG, "clover", "incremental", JSON.stringify({ ...parseCloverCursor(first.cursor), step: "items", offset: 0 }));
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect(again.ingested).toBe(0);
  });
});
