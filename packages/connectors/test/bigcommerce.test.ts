import { beforeEach, describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  BIGCOMMERCE_MOCK_BASE,
  BIGCOMMERCE_TEST_STORE_HASH,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  bigCommerceCustomer,
  bigCommerceDocMock,
  bigCommerceInventoryItem,
  bigCommerceOrder,
  bigCommerceOrderLine,
  bigCommercePriceList,
  bigCommercePriceRecord,
  bigCommerceProduct,
  bigCommerceRefund,
  bigCommerceRfc2822,
  checkConnectorSync,
  testPipeline,
  type BigCommerceMock,
  type BigCommerceMockData,
  type BigCommerceMockRecord,
} from "@karatos/connector-testkit";
import {
  BIGCOMMERCE_API_HOST,
  BIGCOMMERCE_OVERLAP_MS,
  BIGCOMMERCE_REPLAY_WINDOW_MS,
  BIGCOMMERCE_ROUTES,
  BIGCOMMERCE_WEBHOOK_HEADER,
  BIGCOMMERCE_WEBHOOK_SCOPES,
  BIGCOMMERCE_WRITES,
  BigCommerceApiError,
  BigCommerceConfigError,
  BigCommerceCustomerKeyError,
  BigCommerceWebhookDeduper,
  bigCommerceCents,
  bigCommerceClient,
  bigCommerceConnector,
  bigCommerceCount,
  bigCommerceCustomerEvent,
  bigCommerceCustomerRef,
  bigCommerceId,
  bigCommerceInventoryEvents,
  bigCommerceOrderEvents,
  bigCommercePaymentMethod,
  bigCommercePriceListEvent,
  bigCommercePriceRecordEvent,
  bigCommerceProductEvents,
  bigCommerceTime,
  bigCommerceWebhookChange,
  parseBigCommerceCursor,
  verifyBigCommerceWebhook,
  type BigCommerceConnectorOptions,
  type BigCommerceContext,
  type BigCommerceCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["store", "api", "token", "0".repeat(30)].join("-");
const KEY = ["customer", "ref", "key", "0".repeat(40)].join("-");
const OTHER_KEY = ["customer", "ref", "key", "1".repeat(40)].join("-");
const WEBHOOK_SECRET = ["webhook", "secret", "0".repeat(40)].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const FIVE_YEARS = "2021-01-20T00:00:00Z";
const HASH = BIGCOMMERCE_TEST_STORE_HASH;
const at = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000).toISOString();

const resetBuilders = () => {
  for (const b of [bigCommerceProduct, bigCommerceInventoryItem, bigCommerceCustomer, bigCommerceOrderLine, bigCommerceOrder, bigCommerceRefund, bigCommercePriceList, bigCommercePriceRecord]) b.reset();
};

/** One order with its lines and refunds, numbered from 1001. */
function order(n: number, overrides: BigCommerceMockRecord = {}): BigCommerceMockRecord {
  const base = bigCommerceOrder.one();
  const [line] = base.lines as BigCommerceMockRecord[];
  return { ...base, id: 1000 + n, lines: [{ ...line, id: 500 + n, order_id: 1000 + n }], ...overrides };
}

function store(overrides: Partial<BigCommerceMockData> = {}): BigCommerceMockData {
  resetBuilders();
  const products = bigCommerceProduct.many(3);
  // A variant sold without a SKU or its own price, on a hidden product.
  products[1]!.is_visible = false;
  products[1]!.variants = [{ id: 202, product_id: 102, sku: "", price: null, calculated_price: null, inventory_level: 0 }];
  const inventory = bigCommerceInventoryItem.many(2);
  (inventory[1]!.locations as BigCommerceMockRecord[]).push({ location_id: 2, total_inventory_onhand: 4, available_to_sell: 4 });
  const sold = order(1, { status_id: 14, status: "Partially Refunded", refunded_amount: "50.0000", refunds: [bigCommerceRefund.one()] });
  const pending = order(2, { status_id: 1, status: "Pending" });
  const cash = order(3, {
    customer_id: 0,
    payment_method: "Cash",
    total_inc_tax: "900.0000",
    lines: [
      { id: 531, order_id: 1003, product_id: 101, variant_id: 201, sku: "SKU-TEST-0001-6", quantity: 1, base_price: "600.0000", applied_discounts: [] },
      { id: 532, order_id: 1003, product_id: 102, variant_id: 202, sku: "", quantity: 2, base_price: "150.0000", applied_discounts: [] },
    ],
  });
  // An order BigCommerce returned without its creation time: the sale is dead-lettered, not given a made-up time.
  const timeless = order(4);
  delete timeless.date_created;
  const shipping = order(5, { status_id: 14, refunded_amount: "10.0000", refunds: [bigCommerceRefund.one({ order_id: 1005, items: [{ item_type: "SHIPPING", item_id: 1, quantity: 1, requested_amount: "10.00" }] })] });
  const lists = bigCommercePriceList.many(2);
  const records = [...bigCommercePriceRecord.many(2), bigCommercePriceRecord.one({ price_list_id: 2, currency: "cad" })];
  return {
    token: TOKEN,
    products,
    inventory,
    customers: bigCommerceCustomer.many(2),
    orders: [sold, pending, cash, timeless, shipping],
    priceLists: lists,
    priceListRecords: records,
    ...overrides,
  };
}

const options = (mock: BigCommerceMock, extra: Partial<BigCommerceConnectorOptions> = {}): BigCommerceConnectorOptions => ({
  storeHash: HASH,
  accessToken: TOKEN,
  customerKey: KEY,
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});
const connector = (mock: BigCommerceMock, extra: Partial<BigCommerceConnectorOptions> = {}) => bigCommerceConnector(options(mock, extra));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const pathOf = (url: string) => new URL(url).pathname.replace(`/stores/${HASH}`, "");
const paths = (mock: BigCommerceMock) => mock.fetch.calls.map((c) => `${c.method} ${pathOf(c.url)}`);
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

/** A fetch that records each request's method, URL and headers before the mock answers it. */
function recording(mock: BigCommerceMock) {
  const sent: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as string, init);
    sent.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: init?.body === undefined ? null : String(init.body) });
    return mock.fetch(request);
  };
  return { fetch, sent };
}

/** Answers the store check from the mock and every other read with `answer`. */
const readsAnswer = (mock: BigCommerceMock, answer: () => Response): typeof globalThis.fetch => async (input, init) =>
  pathOf(String(input)) === "/v2/store" ? mock.fetch(input as string, init) : answer();

const ctx = (key = KEY): BigCommerceContext => ({ receivedAt: RECEIVED, customerRef: (v) => bigCommerceCustomerRef(key, HASH, v) });

describe("BigCommerce client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(bigCommerceDocMock(store()));
    for (const bad of ["", "ABC123DEF", "abc", "a".repeat(17), "abc/../x", "abc123 def"]) {
      expect(() => bigCommerceClient({ ...base, storeHash: bad })).toThrow(new BigCommerceConfigError("BIGCOMMERCE_STORE_HASH must be the store hash from the API path: 6 to 16 lower-case letters and digits"));
    }
    expect(() => bigCommerceClient({ ...base, accessToken: " " })).toThrow("set BIGCOMMERCE_ACCESS_TOKEN");
    expect(bigCommerceClient({ ...base, storeHash: ` ${HASH} ` }).baseUrl).toBe(BIGCOMMERCE_MOCK_BASE);
    expect(BIGCOMMERCE_API_HOST).toBe("https://api.bigcommerce.com");
  });

  it("reads only its listed paths with their listed parameters, before any request is made", async () => {
    const mock = bigCommerceDocMock(store());
    const client = bigCommerceClient(options(mock));
    await expect(client.read("orders/../../v2/customers" as never)).rejects.toThrow(new BigCommerceConfigError("the BigCommerce connector only reads its listed paths"));
    await expect(client.read("toString" as never)).rejects.toThrow(BigCommerceConfigError);
    await expect(client.read("orders", { query: { min_date_modified: "x", status_id: 5 } })).rejects.toThrow("the BigCommerce connector doesn't send status_id to /v2/orders");
    await expect(client.read("orders", { query: { "date_modified:min": "x" } })).rejects.toThrow("doesn't send date_modified:min");
    await expect(client.read("orders", { query: { page: { nested: 1 } as never } })).rejects.toThrow("page must be a plain value");
    await expect(client.read("orderProducts", { path: { order_id: "../1" } })).rejects.toThrow("order_id must be a BigCommerce ID");
    await expect(client.read("orderProducts", { path: { order_id: 0 } })).rejects.toThrow("order_id must be a BigCommerce ID");
    await expect(client.read("orderProducts")).rejects.toThrow("order_id must be a BigCommerce ID");
    await expect(client.read("orders", { path: { order_id: 1 } })).rejects.toThrow("doesn't fill order_id in /v2/orders");
    expect(mock.fetch.calls).toEqual([]);
    expect(Object.values(BIGCOMMERCE_ROUTES).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v2/store",
      "GET /v2/orders",
      "GET /v2/orders/{order_id}/products",
      "GET /v3/orders/{order_id}/payment_actions/refunds",
      "GET /v3/catalog/products",
      "GET /v3/inventory/items",
      "GET /v3/customers",
      "GET /v3/pricelists",
      "GET /v3/pricelists/{price_list_id}/records",
    ]);
  });

  it("checks the token belongs to the store once, then sends GETs with X-Auth-Token and nothing else", async () => {
    const mock = bigCommerceDocMock(store());
    const { fetch, sent } = recording(mock);
    const client = bigCommerceClient(options(mock, { fetch }));
    await client.read("orders", { query: { page: 1, limit: 50 } });
    await client.read("orderProducts", { path: { order_id: 1001 } });
    expect(sent.map((s) => `${s.method} ${pathOf(s.url)}`)).toEqual(["GET /v2/store", "GET /v2/orders", "GET /v2/orders/1001/products"]);
    for (const s of sent) {
      expect(s.headers).toEqual({ "x-auth-token": TOKEN, accept: "application/json" });
      expect(s.body).toBeNull();
    }
    expect(query(sent[1]!.url)).toEqual({ page: "1", limit: "50" });
  });

  it("stops before reading anything when the token belongs to another store, and checks again next time", async () => {
    const mock = bigCommerceDocMock(store({ store: { id: "otherstore" } }));
    const client = bigCommerceClient(options(mock));
    const error = await failure(client.read("orders"));
    expect(error).toEqual(new BigCommerceConfigError("the BigCommerce token belongs to a different store than BIGCOMMERCE_STORE_HASH"));
    await failure(client.read("customers"));
    expect(paths(mock)).toEqual(["GET /v2/store", "GET /v2/store"]);
    const wrong = bigCommerceDocMock({ ...store(), token: "different" });
    await expect(bigCommerceClient(options(wrong)).read("orders")).rejects.toMatchObject({ name: "BigCommerceApiError", status: 401 });
  });

  it("waits out the window when no requests are left, and on 429 waits the reset or backs off, then leaves the error to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    // Quota of 2: the store check and one read use it up; the next read waits for the window.
    const tight = bigCommerceDocMock(store({ quota: 2 }));
    const client = bigCommerceClient(options(tight, { sleep }));
    await client.read("priceLists");
    expect(waits).toEqual([]);
    await client.read("priceLists");
    expect(waits).toEqual([29_999]);
    const limited = bigCommerceDocMock(store({ rateLimits: [{}, { resetMs: 7000 }, { resetMs: 3_600_000 }] }));
    waits.length = 0;
    await bigCommerceClient(options(limited, { sleep })).read("priceLists");
    expect(waits).toEqual([1000, 7000, 60_000]);
    const always = readsAnswer(limited, () => new Response(JSON.stringify({ status: 429, title: "Too many requests" }), { status: 429, headers: { "x-rate-limit-time-reset-ms": "abc" } }));
    waits.length = 0;
    const error = await failure(bigCommerceClient(options(limited, { fetch: always, sleep })).read("priceLists"));
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(error).toMatchObject({ name: "BigCommerceApiError", status: 429, message: "BigCommerce kept rate-limiting the sync; the next run resumes from the checkpoint" });
    // A missing reset with nothing left waits a second.
    waits.length = 0;
    const empty = readsAnswer(limited, () => new Response("{}", { status: 200, headers: { "x-rate-limit-requests-left": "0" } }));
    const drained = bigCommerceClient(options(limited, { fetch: empty, sleep }));
    await drained.read("priceLists");
    await drained.read("priceLists");
    expect(waits).toEqual([1000]);
  });

  it("reports BigCommerce's errors cut short, with a hint on auth failures, and never the token", async () => {
    const mock = bigCommerceDocMock(store());
    const read = async (response: () => Response) => failure(bigCommerceClient(options(mock, { fetch: readsAnswer(mock, response) })).read("customers"));
    const long = await read(() => new Response(JSON.stringify({ status: 422, title: "x".repeat(500) }), { status: 422 }));
    expect(long.message.length).toBeLessThan(260);
    const forbidden = await read(() => new Response(JSON.stringify({ status: 403, title: "You don't have a required scope to access the endpoint" }), { status: 403 }));
    expect(forbidden.message).toBe("BigCommerce answered HTTP 403 (You don't have a required scope to access the endpoint); check the API account's token and its read-only scopes");
    const v2 = await read(() => new Response(JSON.stringify([{ status: 400, message: "The field 'sort' is invalid." }]), { status: 400 }));
    expect(v2.message).toBe("BigCommerce answered HTTP 400 (The field 'sort' is invalid.)");
    expect(await read(() => new Response("not json", { status: 500 }))).toEqual(new BigCommerceApiError("BigCommerce answered HTTP 500", 500));
    expect((await read(() => new Response("not json", { status: 200 }))).message).toBe("BigCommerce did not answer with JSON");
    expect((await read(() => new Response("5", { status: 200 }))).message).toBe("BigCommerce did not answer with JSON");
    const empty = await bigCommerceClient(options(mock, { fetch: readsAnswer(mock, () => new Response(null, { status: 204 })) })).read("orders");
    expect(empty).toEqual([]);
    for (const message of [long.message, forbidden.message, v2.message]) expect(message).not.toContain(TOKEN);
  });
});

describe("BigCommerce normalization", () => {
  beforeEach(resetBuilders);
  const all = () => {
    const data = store();
    return [
      ...data.products!.flatMap((p) => bigCommerceProductEvents(p, ctx())),
      ...data.inventory!.flatMap((i) => bigCommerceInventoryEvents(i, RECEIVED, ctx())),
      ...data.customers!.flatMap((c) => bigCommerceCustomerEvent(c, ctx()) ?? []),
      ...data.orders!.flatMap((o) => bigCommerceOrderEvents(o, o.lines as BigCommerceMockRecord[], o.refunds as BigCommerceMockRecord[], ctx())),
      ...data.priceLists!.flatMap((l) => bigCommercePriceListEvent(l, ctx()) ?? []),
      ...data.priceListRecords!.flatMap((r) => bigCommercePriceRecordEvent(r, ctx()) ?? []),
    ];
  };

  it("keeps nothing personal: no names, contact details, addresses, IP addresses, notes or messages", () => {
    const text = JSON.stringify(all());
    for (const personal of ["@", "555", "Test Street", "Testville", "Customer 1", "Synthetic", "192.0.2", "Ring Size", "engraving", "Engraving", "coupon", "TEST\"", "\"customer_id\""]) {
      expect(text, personal).not.toContain(personal);
    }
  });

  it("gives a paid order the Shopify connector's order and sale events", () => {
    const o = order(1);
    const events = bigCommerceOrderEvents(o, o.lines as BigCommerceMockRecord[], [], ctx());
    const customerId = bigCommerceCustomerRef(KEY, HASH, 1);
    expect(events.map((e) => [e.type, e.idempotencyKey])).toEqual([
      ["order.updated", "bigcommerce:order:1001:2026-01-01T03:00:00.000Z"],
      ["sale.completed", "bigcommerce:sale:1001"],
    ]);
    expect(events[0]!.payload).toEqual({
      orderId: "bigcommerce:order:1001",
      createdAt: "2026-01-01T01:00:00.000Z",
      status: "Completed",
      statusId: 10,
      channel: "online",
      currency: "USD",
      totalCents: 120_000,
      refundedCents: 0,
      lineCount: 1,
      linesComplete: true,
      customerId,
    });
    expect(events[1]).toMatchObject({
      occurredAt: "2026-01-01T01:00:00.000Z",
      payload: { saleId: "bigcommerce:order:1001", customerId, channel: "online", lines: [{ sku: "SKU-TEST-0001-6", quantity: 1, unitPriceCents: 125_000, discountCents: 5_000 }], totalCents: 120_000, payments: [{ method: "card", amountCents: 120_000 }] },
    });
    expect(customerId).toMatch(/^bigcommerce:customer:[0-9a-f]{32}$/);
  });

  it("records no sale until an order is paid and every line can be read", () => {
    const base = order(1);
    const lines = base.lines as BigCommerceMockRecord[];
    const types = (o: BigCommerceMockRecord, l = lines) => bigCommerceOrderEvents(o, l, [], ctx()).map((e) => e.type);
    for (const status of [0, 1, 5, 6, 7, 12, 13, null]) expect(types({ ...base, status_id: status }), String(status)).toEqual(["order.updated"]);
    for (const status of [2, 3, 4, 8, 9, 10, 11, 14]) expect(types({ ...base, status_id: status }), String(status)).toEqual(["order.updated", "sale.completed"]);
    expect(types({ ...base, total_inc_tax: "0.0000" })).toEqual(["order.updated"]);
    expect(types(base, [])).toEqual(["order.updated"]);
    for (const line of [
      { ...lines[0], quantity: 1.5 },
      { ...lines[0], base_price: "free" },
      { ...lines[0], base_price: "-1.00" },
      { ...lines[0], applied_discounts: [{ amount: "lots" }] },
      { ...lines[0], applied_discounts: [{ amount: "-5.00" }] },
      { quantity: 1, base_price: "1.00" },
    ]) {
      expect(types(base, [line as BigCommerceMockRecord]), JSON.stringify(line)).toEqual(["order.updated"]);
    }
    // Zero-quantity lines are left out; a line without a SKU gets its variant's stand-in, then its own.
    const sale = bigCommerceOrderEvents(base, [{ id: 9, quantity: 0, base_price: "1.00" }, { id: 7, variant_id: 77, sku: " ", quantity: 1, base_price: "1.00" }, { id: 8, quantity: 1, base_price: "2.00" }], [], ctx())[1]!.payload;
    expect(sale.lines).toEqual([
      { sku: "bigcommerce-variant-77", quantity: 1, unitPriceCents: 100, discountCents: 0 },
      { sku: "bigcommerce-line-1001-8", quantity: 1, unitPriceCents: 200, discountCents: 0 },
    ]);
    // A guest checkout has no customer, and a POS order was sold in the store.
    const guest = bigCommerceOrderEvents({ ...base, customer_id: 0, order_source: "bigcommerce-pos" }, lines, [], ctx());
    expect(guest[0]!.payload).not.toHaveProperty("customerId");
    expect(guest[1]!.payload).toMatchObject({ channel: "store" });
    expect(guest[1]!.payload).not.toHaveProperty("customerId");
    expect(bigCommerceOrderEvents({ ...base, id: "../x" }, lines, [], ctx())).toEqual([]);
    expect(bigCommerceOrderEvents(null as never, [], [], ctx())).toEqual([]);
    const timeless = bigCommerceOrderEvents({ ...base, date_modified: undefined, currency_code: "dollars", status: undefined }, lines, [], ctx())[0]!;
    expect([timeless.occurredAt, timeless.idempotencyKey.endsWith(":unknown"), timeless.payload.status, timeless.payload.currency]).toEqual([undefined, true, null, undefined]);
  });

  it("maps the store's payment methods to the sales department's", () => {
    const methods = ["Credit Card", "Stripe", "PayPal", "Cash", "Cash on Delivery", "Check", "Cheque", "Gift Certificate", "Affirm", "Klarna", "Bank Deposit", "Wire transfer", "Store Credit", "Manual", "", undefined, 5];
    expect(methods.map(bigCommercePaymentMethod)).toEqual(["card", "card", "card", "cash", "cash", "check", "check", "gift_card", "financing", "financing", "wire", "wire", "other", "other", "other", "other", "other"]);
  });

  it("turns each refund with product lines into a sale.returned against the sale", () => {
    const o = order(1);
    const lines = [...(o.lines as BigCommerceMockRecord[]), { id: 599, sku: "", variant_id: 299, quantity: 2, base_price: "10.00" }];
    const refunds = [
      bigCommerceRefund.one({ items: [{ item_type: "PRODUCT", item_id: 501, quantity: 1, requested_amount: "50.00" }, { item_type: "PRODUCT", item_id: 599, quantity: 2, requested_amount: null }, { item_type: "SHIPPING", item_id: 501, quantity: 1, requested_amount: "10.00" }] }),
      bigCommerceRefund.one({ items: [{ item_type: "ORDER", item_id: 1001, quantity: 1, requested_amount: "5.00" }] }),
      bigCommerceRefund.one({ items: [{ item_type: "PRODUCT", item_id: 404, quantity: 1 }, { item_type: "PRODUCT", item_id: 501, quantity: 0 }] }),
      { id: "x", items: [{ item_type: "PRODUCT", item_id: 501, quantity: 1 }] },
    ];
    const returned = bigCommerceOrderEvents(o, lines, refunds, ctx()).filter((e) => e.type === "sale.returned");
    expect(returned.map((e) => [e.idempotencyKey, e.occurredAt, e.payload])).toEqual([
      [
        "bigcommerce:refund:701",
        "2026-01-01T11:00:00.000Z",
        { saleId: "bigcommerce:order:1001", returnId: "bigcommerce:refund:701", lines: [{ sku: "SKU-TEST-0001-6", quantity: 1, refundCents: 5_000 }, { sku: "bigcommerce-variant-299", quantity: 2, refundCents: 0 }] },
      ],
    ]);
  });

  it("gives products the Shopify connector's product shape, with each variant's SKU and price", () => {
    const product = bigCommerceProduct.one();
    expect(bigCommerceProductEvents(product, ctx())).toEqual([
      {
        id: "bigcommerce_product:101:2026-01-01T01:00:00.000Z",
        type: "product.updated",
        occurredAt: "2026-01-01T01:00:00.000Z",
        receivedAt: RECEIVED,
        idempotencyKey: "bigcommerce:product:101:2026-01-01T01:00:00.000Z",
        payload: {
          productId: "bigcommerce:product:101",
          title: "Test 14K Ring 1",
          status: "ACTIVE",
          vendor: null,
          productType: "physical",
          tags: [],
          // The variant has no price of its own, so it sells at its calculated price.
          variants: [{ variantId: "bigcommerce:variant:201", sku: "SKU-TEST-0001-6", priceCents: 125_100, inventoryQuantity: 1 }],
        },
      },
    ]);
    const odd = bigCommerceProductEvents({ ...product, name: " ", type: "Physical Goods", is_visible: false, variants: [{ id: 9, price: "12.5", inventory_level: 1.5 }, { id: 8 }, { id: -1 }] }, ctx())[0]!.payload;
    expect(odd).toMatchObject({
      title: "BigCommerce product 101",
      status: "HIDDEN",
      productType: null,
      variants: [
        { variantId: "bigcommerce:variant:9", sku: "bigcommerce-variant-9", priceCents: 1250, inventoryQuantity: null },
        { variantId: "bigcommerce:variant:8", sku: "bigcommerce-variant-8", priceCents: 125_100, inventoryQuantity: null },
      ],
    });
    expect(bigCommerceProductEvents({ ...product, availability: "disabled" }, ctx())[0]!.payload.status).toBe("DISABLED");
    expect(bigCommerceProductEvents({ id: 5 }, ctx())[0]!.payload.variants).toEqual([]);
    expect(bigCommerceProductEvents({ id: "five" }, ctx())).toEqual([]);
  });

  it("gives inventory the POS connector's inventory.counted shape per location, stored once a day per count", () => {
    const item = bigCommerceInventoryItem.one();
    const [event] = bigCommerceInventoryEvents(item, RECEIVED, ctx());
    expect(event).toMatchObject({
      idempotencyKey: "bigcommerce:count:201:1:2026-01-20:1",
      occurredAt: RECEIVED,
      payload: { sku: "SKU-TEST-0001-6", onHand: 1, variantId: "bigcommerce:variant:201", locationId: "bigcommerce:location:1" },
    });
    const later = bigCommerceInventoryEvents(item, "2026-01-20T05:00:00.000Z", ctx())[0]!;
    expect(later.idempotencyKey).toBe(event!.idempotencyKey);
    const changed = bigCommerceInventoryEvents({ ...item, locations: [{ location_id: 1, total_inventory_onhand: 3 }] }, RECEIVED, ctx())[0]!;
    expect(changed.idempotencyKey).toBe("bigcommerce:count:201:1:2026-01-20:3");
    const odd = bigCommerceInventoryEvents({ identity: { variant_id: 9, sku: "" }, locations: [{ location_id: 2, total_inventory_onhand: 2.5 }, { location_id: 3, total_inventory_onhand: -1 }, { location_id: "x" }] }, RECEIVED, ctx());
    expect(odd.map((e) => [e.payload.sku, e.payload.onHand, e.idempotencyKey])).toEqual([
      ["bigcommerce-variant-9", null, "bigcommerce:count:9:2:2026-01-20:unknown"],
      ["bigcommerce-variant-9", -1, "bigcommerce:count:9:3:2026-01-20:-1"],
    ]);
    expect(bigCommerceInventoryEvents({ identity: {}, locations: [{ location_id: 1 }] }, RECEIVED, ctx())).toEqual([]);
    expect(bigCommerceInventoryEvents(null as never, RECEIVED, ctx())).toEqual([]);
  });

  it("makes customers profiles under a keyed reference, with consent never assumed", () => {
    const customer = bigCommerceCustomer.one();
    const event = bigCommerceCustomerEvent(customer, ctx())!;
    const ref = bigCommerceCustomerRef(KEY, HASH, 1)!;
    expect(event.payload).toEqual({ customerId: ref, name: `BigCommerce customer ${ref.slice(21, 29)}`, marketingConsent: false });
    expect(event.idempotencyKey).toBe(`bigcommerce:customer:${ref.slice(21)}:2026-01-01T02:00:00.000Z`);
    expect(bigCommerceCustomerEvent({ ...customer, id: 0 }, ctx())).toBeNull();
  });

  it("keys customer references with CUSTOMER_REF_KEY and the store, so they link up but can't be looked up without it", () => {
    const a = bigCommerceCustomerRef(KEY, HASH, 1);
    expect(bigCommerceCustomerRef(KEY, HASH, "1")).toBe(a);
    expect(bigCommerceCustomerRef(OTHER_KEY, HASH, 1)).not.toBe(a);
    expect(bigCommerceCustomerRef(KEY, "otherstore", 1)).not.toBe(a);
    expect(bigCommerceCustomerRef(KEY, HASH, 2)).not.toBe(a);
    for (const bad of [0, -1, 1.5, "", "01", "1".repeat(13), "../1", null, undefined, Number.MAX_VALUE]) expect(bigCommerceCustomerRef(KEY, HASH, bad), String(bad)).toBeUndefined();
    expect(() => bigCommerceCustomerRef("short", HASH, 1)).toThrow(BigCommerceCustomerKeyError);
    expect(() => bigCommerceConnector({ ...options(bigCommerceDocMock(store())), customerKey: " " })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("gives B2B price lists and their prices neutral events with each variant's tiers", () => {
    const list = bigCommercePriceList.one();
    expect(bigCommercePriceListEvent(list, ctx())).toMatchObject({
      type: "price_list.updated",
      idempotencyKey: "bigcommerce:price_list:1:2026-01-01T01:00:00.000Z",
      payload: { priceListId: "bigcommerce:price_list:1", name: "Wholesale Tier 1", active: true },
    });
    expect(bigCommercePriceListEvent({ id: 3, active: "yes" }, ctx())!.payload).toEqual({ priceListId: "bigcommerce:price_list:3", name: "BigCommerce price list 3", active: false });
    expect(bigCommercePriceListEvent({ id: null }, ctx())).toBeNull();
    const record = bigCommercePriceRecord.one({ bulk_pricing_tiers: [{ quantity_min: 5, quantity_max: 9, type: "percent", amount: 5 }, { quantity_min: 10, quantity_max: null, type: "fixed", amount: 800 }, { quantity_min: 1, type: "free", amount: 1 }, { quantity_min: 1, type: "price", amount: "1" }] });
    expect(bigCommercePriceRecordEvent(record, ctx())).toEqual({
      id: "bigcommerce_price:1:201:USD:2026-01-01T01:00:00.000Z",
      type: "price_list.price_updated",
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "bigcommerce:price:1:201:USD:2026-01-01T01:00:00.000Z",
      payload: {
        priceListId: "bigcommerce:price_list:1",
        variantId: "bigcommerce:variant:201",
        productId: "bigcommerce:product:101",
        sku: "SKU-TEST-0001-6",
        currency: "USD",
        priceCents: 90_100,
        salePriceCents: null,
        retailPriceCents: 125_000,
        mapPriceCents: null,
        bulkPricingTiers: [
          { quantityMin: 5, quantityMax: 9, type: "percent", amount: 5 },
          { quantityMin: 10, quantityMax: null, type: "fixed", amount: 800 },
        ],
      },
    });
    expect(bigCommercePriceRecordEvent({ price_list_id: 1, variant_id: 2, currency: "usd" }, ctx())!.payload).toMatchObject({ sku: "bigcommerce-variant-2", bulkPricingTiers: [] });
    expect(bigCommercePriceRecordEvent({ price_list_id: 1, variant_id: 2, currency: "usd" }, ctx())!.payload).not.toHaveProperty("productId");
    for (const bad of [{ ...record, currency: "dollars" }, { ...record, currency: 5 }, { ...record, variant_id: 0 }, { ...record, price_list_id: undefined }]) expect(bigCommercePriceRecordEvent(bad, ctx())).toBeNull();
  });

  it("reads BigCommerce's IDs, times, money and counts, and leaves out what it can't", () => {
    expect([bigCommerceId(5), bigCommerceId("5"), bigCommerceId(0), bigCommerceId(-5), bigCommerceId(1.5), bigCommerceId("05"), bigCommerceId("1".repeat(13)), bigCommerceId(null)]).toEqual(["5", "5", undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(bigCommerceTime("Tue, 20 Jan 2026 12:00:00 +0000")).toBe("2026-01-20T12:00:00.000Z");
    expect(bigCommerceTime("2026-01-19T12:00:00-05:00")).toBe("2026-01-19T17:00:00.000Z");
    expect(bigCommerceTime("Tue, 20 Jan 2026 12:00 +0000 (UTC)")).toBe("2026-01-20T12:00:00.000Z");
    // Longer than any time BigCommerce writes, even when it would parse.
    for (const bad of ["soon", "", 5, undefined, "2026-13-45T00:00:00Z", `2026-01-19T12:00:00Z${" ".repeat(40)}`, "Tue, 20 Jan 2026 12:00:00 +0000 (Coordinated Universal Time)"]) expect(bigCommerceTime(bad), String(bad)).toBeUndefined();
    expect(["125.5000", "125.5", "125", "0.004", "0.005", "1.995", "-12.30", "-0.001", 12.34, 1.005, 0, " 7.10 "].map(bigCommerceCents)).toEqual([12550, 12550, 12500, 0, 1, 200, -1230, 0, 1234, 101, 0, 710]);
    for (const bad of [`1.00${" ".repeat(30)}`, "", "1e5", "1,000.00", "12.3456789", "x", null, undefined, Number.NaN, Infinity, 1e13, "1".repeat(25), {}]) expect(bigCommerceCents(bad), String(bad)).toBeNull();
    expect([bigCommerceCount(3), bigCommerceCount(-1), bigCommerceCount(1.5), bigCommerceCount("3")]).toEqual([3, -1, null, null]);
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(store())).not.toThrow();
  });

  it("runs its patterns in linear time on hostile input", () => {
    const hostile = "1".repeat(200_000);
    const started = performance.now();
    bigCommerceCents(`${hostile}.`);
    bigCommerceCents(`${"1".repeat(12)}.${"1".repeat(100_000)}x`);
    bigCommerceTime(`${"9".repeat(100_000)}T`);
    bigCommerceId(hostile);
    bigCommercePaymentMethod(`${"cash".repeat(100_000)}!`);
    bigCommerceOrderEvents({ id: 1, order_source: "pos".repeat(100_000), currency_code: "A".repeat(100_000), status_id: 10, total_inc_tax: hostile }, [{ id: 1, sku: hostile, quantity: 1, base_price: hostile }], [], ctx());
    bigCommerceProductEvents({ id: 1, type: `${"a".repeat(100_000)}!` }, ctx());
    verifyBigCommerceWebhook(WEBHOOK_SECRET, "A".repeat(200_000));
    bigCommerceWebhookChange({ producer: `stores/${HASH}`, scope: "store/order/updated", hash: `${"a".repeat(100_000)}!`, created_at: 1 }, { storeHash: HASH, now: 0 });
    expect(() => parseBigCommerceCursor(JSON.stringify({ pass: "historical", step: "orders", page: 1, from: `${"9".repeat(100_000)}Z`, seen: [], listId: null }))).toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("BigCommerce sync", () => {
  it("imports, replays, resumes and retries the mocked store", async () => {
    // 3 products; 3 counts; 2 customers; orders: a sale with a refund (3 events), a pending order, a guest cash sale (2),
    // a sale without its creation time (order.updated kept, the sale dead-lettered) and a sale refunded only for shipping (2);
    // 2 price lists and 3 prices.
    const result = await checkConnectorSync({ makeConnector: () => connector(bigCommerceDocMock(store())), expected: { ingested: 22, deadLettered: 1 } });
    // Products, inventory, customers, orders, price lists, and each list's prices.
    expect(result.full.batches).toBe(7);
    expect(parseBigCommerceCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", page: 1, from: null, seen: [], listId: null });
  });

  it("reads every stream five years back, oldest change first, with the documented parameters", async () => {
    const mock = bigCommerceDocMock(store());
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(sent.map((s) => `${pathOf(s.url)}${new URL(s.url).search}`)).toEqual([
      "/v2/store",
      `/v3/catalog/products?date_modified%3Amin=${encodeURIComponent(FIVE_YEARS)}&sort=date_modified&direction=asc&include=variants&page=1&limit=250`,
      "/v3/inventory/items?page=1&limit=250",
      `/v3/customers?date_modified%3Amin=${encodeURIComponent(FIVE_YEARS)}&sort=date_modified%3Aasc&page=1&limit=250`,
      `/v2/orders?min_date_modified=${encodeURIComponent(FIVE_YEARS)}&sort=date_modified%3Aasc&page=1&limit=50`,
      "/v2/orders/1001/products?page=1&limit=250",
      "/v3/orders/1001/payment_actions/refunds",
      "/v2/orders/1002/products?page=1&limit=250",
      "/v2/orders/1003/products?page=1&limit=250",
      "/v2/orders/1004/products?page=1&limit=250",
      "/v2/orders/1005/products?page=1&limit=250",
      "/v3/orders/1005/payment_actions/refunds",
      "/v3/pricelists?page=1&limit=250",
      "/v3/pricelists?page=1&limit=250",
      "/v3/pricelists/1/records?include=sku&page=1&limit=250",
      "/v3/pricelists/2/records?include=sku&page=1&limit=250",
    ]);
    expect(sent.every((s) => s.method === "GET")).toBe(true);
    const cash = memory.events.find((e) => e.idempotencyKey === "bigcommerce:sale:1003")!;
    expect(cash.payload).toMatchObject({ lines: [{ sku: "SKU-TEST-0001-6", quantity: 1 }, { sku: "bigcommerce-variant-202", quantity: 2 }], payments: [{ method: "cash", amountCents: 90_000 }] });
    expect(cash.payload).not.toHaveProperty("customerId");
    const counted = memory.events.filter((e) => e.type === "inventory.counted").map((e) => [e.payload.sku, e.payload.onHand, e.payload.locationId]);
    expect(counted).toEqual([
      ["SKU-TEST-0001-6", 1, "bigcommerce:location:1"],
      ["SKU-TEST-0002-6", 2, "bigcommerce:location:1"],
      ["SKU-TEST-0002-6", 4, "bigcommerce:location:2"],
    ]);
    const prices = memory.events.filter((e) => e.type === "price_list.price_updated").map((e) => [e.payload.priceListId, e.payload.sku, e.payload.currency]);
    expect(prices).toEqual([
      ["bigcommerce:price_list:1", "SKU-TEST-0001-6", "USD"],
      ["bigcommerce:price_list:1", "SKU-TEST-0002-6", "USD"],
      ["bigcommerce:price_list:2", "SKU-TEST-0003-6", "CAD"],
    ]);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(bigCommerceDocMock(store())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 22, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(
      new Set(["product.updated", "inventory.counted", "customer.profile_updated", "order.updated", "sale.completed", "sale.returned", "price_list.updated", "price_list.price_updated"]),
    );
    expect(memory.events.filter((e) => e.type === "sale.completed")).toHaveLength(3);
  });

  it("pages by change time, skipping records already read at the time a page ends, even when more share it than fit on a page", async () => {
    const data = store();
    bigCommerceProduct.reset();
    // 260 products changed in the same second, then 40 more.
    data.products = bigCommerceProduct.many(300, (n) => ({ id: n, date_modified: n <= 260 ? "2026-01-02T00:00:00+00:00" : `2026-01-03T00:${String(Math.floor((n - 261) / 60)).padStart(2, "0")}:${String((n - 261) % 60).padStart(2, "0")}+00:00`, variants: [] }));
    const mock = bigCommerceDocMock(data);
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const products = memory.events.filter((e) => e.type === "product.updated");
    expect(new Set(products.map((e) => e.payload.productId)).size).toBe(300);
    expect(products).toHaveLength(300);
    expect(report.duplicates).toBe(0);
    const reads = sent.filter((s) => pathOf(s.url) === "/v3/catalog/products").map((s) => [query(s.url)["date_modified:min"], query(s.url).page]);
    expect(reads).toEqual([
      [FIVE_YEARS, "1"],
      ["2026-01-02T00:00:00Z", "1"],
      ["2026-01-02T00:00:00Z", "2"],
    ]);
  });

  it("misses nothing when a record changes while the pass pages through", async () => {
    const data = store();
    bigCommerceProduct.reset();
    data.products = bigCommerceProduct.many(500, (n) => ({ id: n, date_modified: new Date(Date.parse("2025-01-01T00:00:00Z") + n * 1000).toISOString().replace(".000Z", "+00:00"), variants: [] }));
    const mock = bigCommerceDocMock(data);
    let pagesRead = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await mock.fetch(input as string, init);
      // After the first page, an early product is edited: it moves to the end of the list.
      if (pathOf(String(input)) === "/v3/catalog/products" && ++pagesRead === 1) data.products![9]!.date_modified = "2026-01-19T00:00:00+00:00";
      return response;
    };
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const products = memory.events.filter((e) => e.type === "product.updated");
    expect(new Set(products.map((e) => e.payload.productId)).size).toBe(500);
    // Product 10 was read before and after its edit.
    expect(products.filter((e) => e.payload.productId === "bigcommerce:product:10")).toHaveLength(2);
  });

  it("reads every page of a large order's lines and every page of each stream", async () => {
    const data = store();
    const big = data.orders![0]!;
    big.status_id = 10;
    big.refunds = [];
    big.lines = Array.from({ length: 251 }, (_, i) => ({ id: 2000 + i, sku: `SKU-TEST-${String(i).padStart(4, "0")}`, quantity: 1, base_price: "1.00", applied_discounts: [] }));
    big.total_inc_tax = "251.00";
    bigCommerceCustomer.reset();
    data.customers = bigCommerceCustomer.many(251, (n) => ({ date_modified: new Date(Date.parse("2025-01-01T00:00:00Z") + n * 1000).toISOString() }));
    data.inventory = bigCommerceInventoryItem.many(251);
    data.priceListRecords = bigCommercePriceRecord.many(251);
    bigCommerceOrder.reset();
    bigCommerceOrderLine.reset();
    data.orders = [big, ...Array.from({ length: 50 }, (_, i) => order(10 + i, { date_modified: bigCommerceRfc2822(at(10 + i)) }))];
    const mock = bigCommerceDocMock(data);
    const { fetch, sent } = recording(mock);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const sale = memory.events.find((e) => e.idempotencyKey === "bigcommerce:sale:1001")!;
    expect((sale.payload.lines as unknown[]).length).toBe(251);
    expect(sent.filter((s) => pathOf(s.url) === "/v2/orders/1001/products").map((s) => query(s.url).page)).toEqual(["1", "2"]);
    expect(memory.events.filter((e) => e.type === "customer.profile_updated")).toHaveLength(251);
    expect(memory.events.filter((e) => e.type === "inventory.counted").length).toBeGreaterThanOrEqual(251);
    expect(memory.events.filter((e) => e.type === "price_list.price_updated")).toHaveLength(251);
    expect(memory.events.filter((e) => e.type === "order.updated")).toHaveLength(51);
    expect(sent.filter((s) => pathOf(s.url) === "/v2/orders").length).toBe(2);
    expect(report.duplicates).toBe(0);
  });

  it("leaves a finished import finished", async () => {
    const done: BigCommerceCursor = { pass: "historical", step: "done", page: 1, from: null, seen: [], listId: null, since: FIVE_YEARS, startedAt: "2026-01-20T00:00:00Z", nextFrom: "2026-01-19T23:55:00Z" };
    const mock = bigCommerceDocMock(store());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads changes since the last pass started, and starts the next a little before this one", async () => {
    const data = store();
    const recent = "2026-01-19T10:00:00+00:00";
    data.products![0]!.date_modified = recent;
    data.customers![0]!.date_modified = recent;
    data.priceListRecords![0]!.date_modified = recent;
    data.orders![1]!.date_modified = bigCommerceRfc2822("2026-01-19T10:00:00Z");
    const mock = bigCommerceDocMock(data);
    const { fetch, sent } = recording(mock);
    const previous: BigCommerceCursor = { pass: "incremental", step: "done", page: 1, from: null, seen: [], listId: null, since: "2026-01-18T00:00:00Z", startedAt: "2026-01-19T00:05:00Z", nextFrom: "2026-01-19T00:00:00Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "bigcommerce", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Changed records, every count and every price list (both read in full each pass).
    expect(memory.events.map((e) => e.type).sort()).toEqual(
      ["customer.profile_updated", "inventory.counted", "inventory.counted", "inventory.counted", "order.updated", "price_list.price_updated", "price_list.updated", "price_list.updated", "product.updated"].sort(),
    );
    expect(report.duplicates).toBe(0);
    const since = "2026-01-19T00:00:00Z";
    const q = (path: string) => query(sent.find((s) => pathOf(s.url) === path)!.url);
    expect(q("/v3/catalog/products")["date_modified:min"]).toBe(since);
    expect(q("/v3/customers")["date_modified:min"]).toBe(since);
    expect(q("/v2/orders").min_date_modified).toBe(since);
    expect(q("/v3/pricelists/1/records")["date_modified:min"]).toBe(since);
    expect(parseBigCommerceCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", page: 1, from: null, seen: [], listId: null, since, startedAt: "2026-01-20T00:00:00Z", nextFrom: "2026-01-19T23:55:00Z" });
    expect(BIGCOMMERCE_OVERLAP_MS).toBe(5 * 60_000);
    // A second pass the same day stores the same counts as duplicates.
    const again = await runSync({ connector: connector(bigCommerceDocMock(data), { now: () => new Date("2026-01-20T01:00:00Z") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(again.duplicates).toBeGreaterThanOrEqual(3);
    expect(memory.events.filter((e) => e.type === "inventory.counted")).toHaveLength(3);
  });

  it("looks back 48 hours on a first incremental sync, and resumes an interrupted pass where it stopped", async () => {
    const mock = bigCommerceDocMock(store());
    const { fetch, sent } = recording(mock);
    for await (const _ of connector(mock, { fetch }).incrementalSync({ organizationId: TEST_ORG, cursor: null })) break;
    expect(query(sent.find((s) => pathOf(s.url) === "/v3/catalog/products")!.url)["date_modified:min"]).toBe("2026-01-18T00:00:00Z");
    const stopped: BigCommerceCursor = { pass: "incremental", step: "price_list_records", page: 1, from: null, seen: [], listId: "2", since: "2025-01-19T00:00:00Z", startedAt: "2026-01-19T23:00:00Z", nextFrom: "2026-01-19T22:55:00Z" };
    const fresh = bigCommerceDocMock(store());
    const batches = [];
    for await (const b of connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) batches.push(b);
    expect(paths(fresh)).toEqual(["GET /v2/store", "GET /v3/pricelists", "GET /v3/pricelists/2/records"]);
    expect(batches).toHaveLength(1);
    expect(parseBigCommerceCursor(batches[0]!.cursor)).toMatchObject({ step: "done", nextFrom: "2026-01-19T22:55:00Z" });
    // A list deleted since the checkpoint: the next one by ID is read, from its first page.
    const gone = bigCommerceDocMock(store({ priceLists: [bigCommercePriceList.one({ id: 7 })], priceListRecords: [bigCommercePriceRecord.one({ price_list_id: 7 })] }));
    const later: BigCommerceCursor = { ...stopped, listId: "3", page: 4 };
    const read = [];
    for await (const b of connector(gone).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(later) })) read.push(...b.events);
    expect(gone.fetch.calls.map((c) => `${pathOf(c.url)}?page=${new URL(c.url).searchParams.get("page")}`).slice(-1)).toEqual(["/v3/pricelists/7/records?page=1"]);
    expect(read).toHaveLength(1);
    // No price lists at all: the step ends at once.
    const none = bigCommerceDocMock(store({ priceLists: [], priceListRecords: [] }));
    const nothing = [];
    for await (const b of connector(none).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...stopped, listId: null }) })) nothing.push(b);
    expect(nothing.map((b) => b.events.length)).toEqual([0]);
  });

  it("pages price list records by number within a list, then moves to the next list", async () => {
    const data = store();
    bigCommercePriceRecord.reset();
    data.priceListRecords = [...bigCommercePriceRecord.many(251), bigCommercePriceRecord.one({ price_list_id: 2 })];
    bigCommercePriceList.reset();
    data.priceLists = bigCommercePriceList.many(2);
    const mock = bigCommerceDocMock(data);
    const batches: { cursor: string }[] = [];
    const resumed: BigCommerceCursor = { pass: "historical", step: "price_list_records", page: 1, from: null, seen: [], listId: null, since: FIVE_YEARS, startedAt: "2026-01-20T00:00:00Z", nextFrom: "2026-01-19T23:55:00Z" };
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) })) batches.push(b);
    expect(batches.map((b) => { const c = parseBigCommerceCursor(b.cursor)!; return [c.step, c.listId, c.page]; })).toEqual([
      ["price_list_records", "1", 2],
      ["price_list_records", "2", 1],
      ["done", null, 1],
    ]);
  });

  it("finds every price list across pages before reading their prices", async () => {
    const data = store();
    bigCommercePriceList.reset();
    data.priceLists = bigCommercePriceList.many(251);
    data.priceListRecords = [bigCommercePriceRecord.one({ price_list_id: 251 })];
    const mock = bigCommerceDocMock(data);
    const resumed: BigCommerceCursor = { pass: "historical", step: "price_list_records", page: 1, from: null, seen: [], listId: "250", since: FIVE_YEARS, startedAt: "2026-01-20T00:00:00Z", nextFrom: "2026-01-19T23:55:00Z" };
    const events = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) })) events.push(...b.events);
    expect(events.map((e) => (e as { payload: { priceListId: string } }).payload.priceListId)).toEqual(["bigcommerce:price_list:251"]);
    expect(paths(mock).filter((p) => p === "GET /v3/pricelists")).toHaveLength(2);
  });

  it("stops when BigCommerce keeps rate-limiting, keeps the checkpoint where it was, and carries on from there", async () => {
    const mock = bigCommerceDocMock(store());
    const { memory, pipeline } = testPipeline();
    let reads = 0;
    let limited = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (pathOf(String(input)) !== "/v2/store" && ++reads >= 3 && limited) return new Response("{}", { status: 429, headers: { "x-rate-limit-time-reset-ms": "10" } });
      return mock.fetch(input as string, init);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "BigCommerceApiError", status: 429 });
    expect(parseBigCommerceCursor(await memory.getCheckpoint(TEST_ORG, "bigcommerce", "historical"))).toMatchObject({ step: "customers", page: 1 });
    limited = false;
    const resumed = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([resumed.batches, resumed.duplicates]).toEqual([5, 0]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: BigCommerceCursor = { pass: "incremental", step: "orders", page: 2, from: "2026-01-19T00:00:00Z", seen: ["1", "22"], listId: "3", since: "2026-01-18T00:00:00Z", startedAt: "2026-01-20T00:00:00Z", nextFrom: "2026-01-19T23:55:00Z" };
    expect(parseBigCommerceCursor(JSON.stringify(good))).toEqual(good);
    expect(parseBigCommerceCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "employees" },
      { ...good, page: 0 },
      { ...good, page: 1.5 },
      { ...good, page: 1_000_001 },
      { ...good, page: "2" },
      { ...good, from: "2026-01-19" },
      { ...good, from: "2026-01-19T00:00:00.000Z" },
      { ...good, seen: "1" },
      { ...good, seen: ["01"] },
      { ...good, seen: [1] },
      { ...good, seen: Array.from({ length: 1001 }, (_, i) => String(i + 1)) },
      { ...good, listId: 3 },
      { ...good, listId: "../3" },
      { ...good, since: "2026-13-45T00:00:00Z" },
      { ...good, startedAt: undefined },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      null,
      "text",
    ]) {
      expect(() => parseBigCommerceCursor(JSON.stringify(bad)), JSON.stringify(bad)?.slice(0, 80)).toThrow("BigCommerce checkpoint is not in the expected shape");
    }
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(bigCommerceDocMock(store()));
    expect(c.writes).toBe(BIGCOMMERCE_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["update_inventory", "refused"],
      ["update_price_list_record", "refused"],
    ]);
    expect(c).not.toHaveProperty("write");
    expect(c).not.toHaveProperty("handleWebhook");
  });
});

describe("BigCommerce webhooks", () => {
  const NOW_MS = Date.parse("2026-01-20T00:00:00Z");
  const delivery = (overrides: Record<string, unknown> = {}) => ({
    scope: "store/order/updated",
    store_id: "1000001",
    data: { type: "order", id: 1001 },
    hash: "a".repeat(40),
    created_at: NOW_MS / 1000 - 60,
    producer: `stores/${HASH}`,
    ...overrides,
  });

  it("accepts the shared secret header set when the webhook was created, compared in constant time", () => {
    expect(BIGCOMMERCE_WEBHOOK_HEADER).toBe("x-karatos-webhook-secret");
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, WEBHOOK_SECRET)).toEqual({ ok: true });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, ` ${WEBHOOK_SECRET} `)).toEqual({ ok: true });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, `${WEBHOOK_SECRET}x`)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, WEBHOOK_SECRET.slice(0, -1))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, null)).toEqual({ ok: false, reason: "missing" });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, " ")).toEqual({ ok: false, reason: "missing" });
    expect(verifyBigCommerceWebhook(WEBHOOK_SECRET, "x".repeat(257))).toEqual({ ok: false, reason: "missing" });
    // A short or empty secret never verifies anything, not even itself.
    expect(verifyBigCommerceWebhook("short", "short")).toEqual({ ok: false, reason: "missing" });
    expect(verifyBigCommerceWebhook("", "")).toEqual({ ok: false, reason: "missing" });
  });

  it("names the change a notification prompts a sync for, for this store and inside BigCommerce's retry window", () => {
    const opts = { storeHash: HASH, now: NOW_MS };
    expect(bigCommerceWebhookChange(delivery(), opts)).toEqual({ scope: "store/order/updated", stream: "orders", id: "1001", hash: "a".repeat(40), createdAt: NOW_MS / 1000 - 60 });
    expect(bigCommerceWebhookChange(delivery({ scope: "store/priceList/records/updated", data: { type: "price_list_records" } }), opts)).toMatchObject({ stream: "price_list_records", id: undefined });
    expect(bigCommerceWebhookChange(delivery({ scope: "store/sku/inventory/updated", data: { id: -1 } }), opts)).toMatchObject({ stream: "inventory", id: undefined });
    for (const bad of [
      delivery({ producer: "stores/otherstore" }),
      delivery({ scope: "store/app/uninstalled" }),
      delivery({ scope: "toString" }),
      delivery({ hash: "A".repeat(40) }),
      delivery({ hash: "a".repeat(39) }),
      delivery({ hash: undefined }),
      delivery({ created_at: NOW_MS / 1000 - 49 * 3600 - 1 }),
      delivery({ created_at: NOW_MS / 1000 + 301 }),
      delivery({ created_at: "1768867140" }),
      delivery({ created_at: 1.5 }),
      null,
      [],
      "x",
    ]) {
      expect(bigCommerceWebhookChange(bad, opts), JSON.stringify(bad)).toBeNull();
    }
    expect(bigCommerceWebhookChange(delivery({ created_at: NOW_MS / 1000 - 48 * 3600 }), opts)).not.toBeNull();
    expect(BIGCOMMERCE_REPLAY_WINDOW_MS).toBeGreaterThan(48 * 3_600_000);
    expect(new Set(Object.values(BIGCOMMERCE_WEBHOOK_SCOPES))).toEqual(new Set(["orders", "products", "inventory", "customers", "price_lists", "price_list_records"]));
  });

  it("takes each notification once by its hash within the window, however often it is delivered", () => {
    const opts = { storeHash: HASH, now: NOW_MS };
    const deduper = new BigCommerceWebhookDeduper();
    const first = bigCommerceWebhookChange(delivery(), opts)!;
    expect(deduper.first(first, NOW_MS)).toBe(true);
    expect(deduper.first(first, NOW_MS + 1000)).toBe(false);
    expect(deduper.first(bigCommerceWebhookChange(delivery({ hash: "b".repeat(40) }), opts)!, NOW_MS)).toBe(true);
    expect(deduper.first(first, NOW_MS + BIGCOMMERCE_REPLAY_WINDOW_MS - 1)).toBe(false);
    expect(deduper.first(first, NOW_MS + BIGCOMMERCE_REPLAY_WINDOW_MS + 1)).toBe(true);
    const small = new BigCommerceWebhookDeduper({ maxEntries: 2 });
    const change = (h: string) => ({ ...first, hash: h.repeat(40) });
    expect(["a", "b", "c", "a", "c"].map((h) => small.first(change(h), 0))).toEqual([true, true, true, true, false]);
  });
});

describe("BigCommerce doc mock", () => {
  const call = async (mock: BigCommerceMock, path: string, token = TOKEN) => {
    const response = await mock.fetch(`${BIGCOMMERCE_MOCK_BASE}${path}`, { headers: { "x-auth-token": token, accept: "application/json" } });
    return { status: response.status, json: response.status === 204 ? null : ((await response.json()) as unknown) };
  };

  it("answers like BigCommerce to requests the connector should never send", async () => {
    const mock = bigCommerceDocMock(store());
    expect((await call(mock, "/v2/store", "wrong")).status).toBe(401);
    await expect(mock.fetch(`${BIGCOMMERCE_MOCK_BASE}/v2/orders`, { method: "POST", headers: { "x-auth-token": TOKEN } })).rejects.toThrow("is not in the vendor's docs");
    await expect(mock.fetch(`https://api.bigcommerce.com/stores/otherstore/v2/orders`, { headers: { "x-auth-token": TOKEN } })).rejects.toThrow("is not in the vendor's docs");
    for (const [path, status] of [
      ["/v2/orders?limit=251", 400],
      ["/v2/orders?page=0", 400],
      ["/v2/orders?min_date_modified=soon", 400],
      ["/v2/orders?sort=name:asc", 400],
      ["/v2/orders?sort=id:sideways", 400],
      ["/v2/orders/9999/products", 404],
      ["/v2/orders/1001/products?limit=0", 400],
      ["/v3/orders/9999/payment_actions/refunds", 404],
      ["/v3/catalog/products?date_modified:min=soon", 422],
      ["/v3/catalog/products?sort=colour", 422],
      ["/v3/catalog/products?direction=up", 422],
      ["/v3/customers?date_modified:min=soon", 422],
      ["/v3/customers?sort=email:asc", 422],
      ["/v3/customers?limit=1000", 422],
      ["/v3/pricelists/99/records", 404],
      ["/v3/pricelists/1/records?date_modified:min=soon", 422],
    ] as const) {
      expect((await call(mock, path)).status, path).toBe(status);
    }
  });

  it("keeps the documented defaults: orders by ID, 50 a page, no variants or record SKUs unless asked, 204 for an empty page", async () => {
    const data = store();
    data.orders = [...data.orders!].reverse();
    const mock = bigCommerceDocMock(data);
    const orders = (await call(mock, "/v2/orders")).json as { id: number; products: { resource: string }; lines?: unknown }[];
    expect(orders.map((o) => o.id)).toEqual([1001, 1002, 1003, 1004, 1005]);
    expect(orders[0]!.products.resource).toBe("/orders/1001/products");
    expect(orders[0]).not.toHaveProperty("lines");
    expect((await call(mock, "/v2/orders?page=2")).status).toBe(204);
    expect((await call(mock, "/v2/orders/1001/products?page=2")).status).toBe(204);
    const products = (await call(mock, "/v3/catalog/products")).json as { data: Record<string, unknown>[]; meta: { pagination: Record<string, unknown> } };
    expect(products.data[0]).not.toHaveProperty("variants");
    expect(products.meta.pagination).toMatchObject({ total: 3, count: 3, per_page: 50, current_page: 1, total_pages: 1 });
    const records = (await call(mock, "/v3/pricelists/1/records")).json as { data: Record<string, unknown>[] };
    expect(records.data[0]).not.toHaveProperty("sku");
    const customers = (await call(mock, "/v3/customers?sort=date_modified:desc")).json as { data: { id: number }[] };
    expect(customers.data.map((c) => c.id)).toEqual([2, 1]);
    const newest = (await call(mock, "/v2/orders?sort=date_modified:desc&limit=2")).json as { id: number }[];
    expect(newest.map((o) => o.id)).toEqual([1005, 1004]);
    const store_ = (await call(mock, "/v2/store")).json as { id: string };
    expect(store_.id).toBe(HASH);
  });
});
