import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  WOOCOMMERCE_MOCK_STORE,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  tamper,
  testPipeline,
  wooCommerceDocMock,
  wooCustomer,
  wooDates,
  wooOrder,
  wooProduct,
  wooRefund,
  wooTimes,
  wooVariation,
  type WooCommerceMock,
  type WooCommerceMockData,
  type WooMockRecord,
} from "@karatos/connector-testkit";
import {
  WOOCOMMERCE_ROUTES,
  WOOCOMMERCE_STALE_DELIVERY_MS,
  WOOCOMMERCE_WRITES,
  WooCommerceApiError,
  WooCommerceConfigError,
  WooCommerceCustomerKeyError,
  WooCommerceReplayGuard,
  checkWooCommerceStoreUrl,
  isPrivateAddress,
  parseWooCommerceCursor,
  verifyWooCommerceWebhook,
  wooCents,
  wooCommerceClient,
  wooCommerceConnector,
  wooCommerceCustomerRef,
  wooCommerceDeliveryId,
  wooCommerceWebhookEvents,
  wooCustomerEvent,
  wooOrderEvents,
  wooPaymentMethod,
  wooProductEvents,
  wooQuantity,
  wooRefundEvents,
  wooTime,
  type WooCommerceConnectorOptions,
  type WooCommerceContext,
  type WooCommerceCursor,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["ck", "a".repeat(40)].join("_");
const SECRET = ["cs", "b".repeat(40)].join("_");
const WRITE_KEY = ["ck", "c".repeat(40)].join("_");
const WRITE_SECRET = ["cs", "d".repeat(40)].join("_");
const REF_KEY = ["customer", "ref", "key", "0".repeat(40)].join("-");
const OTHER_REF_KEY = ["customer", "ref", "key", "1".repeat(40)].join("-");
const HOOK_SECRET = ["hook", "secret", "0".repeat(32)].join("");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const HOST = new URL(WOOCOMMERCE_MOCK_STORE).hostname;
const PUBLIC = async () => ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"];

const reset = () => {
  for (const b of [wooOrder, wooProduct, wooVariation, wooCustomer, wooRefund]) b.reset();
};

/** A small synthetic store. See the sync test for what each record gives. */
function store(overrides: Partial<WooCommerceMockData> = {}): WooCommerceMockData {
  reset();
  const simple = wooProduct.one();
  const untracked = wooProduct.one({ sku: "", manage_stock: false, stock_quantity: null });
  const variable = wooProduct.one({ type: "variable", sku: "", price: "980.00", manage_stock: false, stock_quantity: null, variations: [201, 202] });
  const variations = [wooVariation.one(), wooVariation.one({ sku: "", manage_stock: "parent", stock_quantity: null })];
  const sale = wooOrder.one({ refunds: [{ id: 9001, reason: "Synthetic reason", total: "-50.00" }] });
  const pending = wooOrder.one({ status: "pending", date_paid: null, date_paid_gmt: null, date_completed: null, date_completed_gmt: null });
  const cod = wooOrder.one({ status: "processing", payment_method: "cod", date_paid: null, date_paid_gmt: null, date_completed: null, date_completed_gmt: null });
  const guest = wooOrder.one({
    customer_id: 0,
    payment_method: "cod",
    total: "1960.00",
    line_items: [{ id: 5100, name: "Test variation", product_id: 103, variation_id: 202, quantity: 2, subtotal: "1960.00", total: "1960.00", sku: "", price: 980 }],
  });
  const refunds = [wooRefund.one(), wooRefund.one({ parent_id: 1004, line_items: [], amount: "15.00" })];
  const customers = [wooCustomer.one(), wooCustomer.one(), wooCustomer.one({ date_created: null, date_created_gmt: null, date_modified: null, date_modified_gmt: null }), wooCustomer.one({ role: "administrator" })];
  return {
    keys: { [KEY]: { secret: SECRET, permissions: "read" }, [WRITE_KEY]: { secret: WRITE_SECRET, permissions: "write" } },
    products: [simple, untracked, variable],
    variations: { 103: variations },
    orders: [sale, pending, cod, guest],
    refunds,
    customers,
    ...overrides,
  };
}

const options = (mock: WooCommerceMock, extra: Partial<WooCommerceConnectorOptions> = {}): WooCommerceConnectorOptions => ({
  storeUrl: WOOCOMMERCE_MOCK_STORE,
  consumerKey: KEY,
  consumerSecret: SECRET,
  customerKey: REF_KEY,
  fetch: mock.fetch,
  resolve: PUBLIC,
  sleep: async () => {},
  random: () => 0,
  now: NOW,
  ...extra,
});
const connector = (mock: WooCommerceMock, extra: Partial<WooCommerceConnectorOptions> = {}) => wooCommerceConnector(options(mock, extra));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const ctx = (key = REF_KEY, host = HOST): WooCommerceContext => ({ receivedAt: RECEIVED, customerRef: (id) => wooCommerceCustomerRef(key, host, id) });
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);
const reads = (mock: WooCommerceMock) => mock.fetch.calls.map((c) => new URL(c.url).pathname.replace("/wp-json/wc/v3", ""));

/** A fetch that records each request's method, URL and headers before the mock answers it. */
function recording(mock: WooCommerceMock, before?: (url: URL) => void) {
  const sent: { method: string; url: string; auth: string | null; redirect: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input as string, init);
    sent.push({ method: request.method, url: request.url, auth: request.headers.get("authorization"), redirect: init?.redirect ?? "follow" });
    before?.(new URL(request.url));
    return mock.fetch(request);
  };
  return { fetch, sent };
}

describe("WooCommerce store address", () => {
  it("accepts a public https store, with or without a folder, and normalizes it", () => {
    expect(checkWooCommerceStoreUrl(" https://Shop.Example.com/ ")).toBe("https://shop.example.com");
    expect(checkWooCommerceStoreUrl("https://example.com/shop/")).toBe("https://example.com/shop");
    expect(checkWooCommerceStoreUrl("https://example.com:443")).toBe("https://example.com");
    expect(checkWooCommerceStoreUrl("https://xn--bcher-kva.example")).toBe("https://xn--bcher-kva.example");
  });

  it("stops http, credentials, ports, queries, IP addresses, local names and odd paths, never echoing the value", () => {
    const cases: [string, string][] = [
      ["", "set WOOCOMMERCE_STORE_URL"],
      ["http://shop.example.com", "must start with https://"],
      ["ftp://shop.example.com", "must start with https://"],
      ["shop.example.com", "must start with https://"],
      ["https://", "is not a web address"],
      [`https://${KEY}:${SECRET}@shop.example.com`, "must not hold a user name or password"],
      ["https://admin@shop.example.com", "must not hold a user name or password"],
      ["https://shop.example.com:8443", "standard https port"],
      [`https://shop.example.com/?consumer_key=${KEY}`, "must not have a query"],
      ["https://shop.example.com/#x", "must not have a query"],
      ["https://127.0.0.1", "not an IP address"],
      ["https://10.0.0.8/shop", "not an IP address"],
      ["https://[::1]", "not an IP address"],
      ["https://0x7f000001", "not an IP address"],
      ["https://2130706433", "not an IP address"],
      ["https://localhost", "public hostname"],
      ["https://shop.localhost", "local or private host"],
      ["https://printer.local", "local or private host"],
      ["https://db.internal", "local or private host"],
      ["https://intranet", "public hostname"],
      ["https://shop_example.com", "public hostname"],
      ["https://shop.example.com/a%2fb", "plain folder names"],
      ["https://shop.example.com\\@evil.example", "plain folder names"],
      ["https://shop.example.com/wp-json/wc/v3", "without /wp-json"],
      ["https://shop.example.com/wp-admin", "without /wp-json"],
      [`https://${"a".repeat(250)}.com`, "too long"],
    ];
    for (const [value, message] of cases) {
      let error: unknown;
      try {
        checkWooCommerceStoreUrl(value);
      } catch (e) {
        error = e;
      }
      expect(error, value).toBeInstanceOf(WooCommerceConfigError);
      expect((error as Error).message, value).toContain(message);
      if (value.length > 12) expect((error as Error).message, value).not.toContain(value.slice(8));
    }
  });

  it("knows private, local and reserved addresses in IPv4 and IPv6", () => {
    const blocked = [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1",
      "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1",
      "ff02::1", "2001:db8::1", "2002:a00:1::", "2001:0:4136:e378::1", "::127.0.0.1", "not an address", "1.2.3", "",
    ];
    for (const ip of blocked) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("stops before any request when the hostname resolves to a private address, even alongside a public one", async () => {
    for (const addresses of [["10.0.0.5"], ["93.184.215.14", "127.0.0.1"], ["fd00::1"], []]) {
      const mock = wooCommerceDocMock(store());
      const client = wooCommerceClient(options(mock, { resolve: async () => addresses }));
      await expect(client.read("orders")).rejects.toThrow(new WooCommerceConfigError("WOOCOMMERCE_STORE_URL resolves to a private or local address; KaratOS reads public stores only"));
      expect(mock.fetch.calls).toEqual([]);
    }
  });

  it("resolves once per client, and tries again after a lookup fails", async () => {
    const mock = wooCommerceDocMock(store());
    let lookups = 0;
    const client = wooCommerceClient(options(mock, { resolve: async () => (++lookups === 1 ? Promise.reject(new Error("ENOTFOUND")) : ["93.184.215.14"]) }));
    await expect(client.read("orders")).rejects.toMatchObject({ name: "WooCommerceApiError", code: "dns_failed" });
    await client.read("orders");
    await client.read("products");
    expect(lookups).toBe(2);
  });
});

describe("WooCommerce client", () => {
  it("checks the key's form, naming the setting but never the value", () => {
    const mock = wooCommerceDocMock(store());
    expect(() => wooCommerceClient(options(mock, { consumerKey: SECRET }))).toThrow(new WooCommerceConfigError("WOOCOMMERCE_CONSUMER_KEY must be the key's ck_ value, 43 characters"));
    expect(() => wooCommerceClient(options(mock, { consumerKey: KEY.slice(0, 30) }))).toThrow("WOOCOMMERCE_CONSUMER_KEY");
    expect(() => wooCommerceClient(options(mock, { consumerSecret: KEY }))).toThrow(new WooCommerceConfigError("WOOCOMMERCE_CONSUMER_SECRET must be the key's cs_ value, 43 characters"));
    expect(() => wooCommerceClient(options(mock, { consumerSecret: undefined as never }))).toThrow("WOOCOMMERCE_CONSUMER_SECRET");
    expect(wooCommerceClient(options(mock, { consumerKey: ` ${KEY} ` })).storeHost).toBe(HOST);
  });

  it("reads only its listed endpoints with their listed parameters, before any request is made", async () => {
    const mock = wooCommerceDocMock(store());
    const client = wooCommerceClient(options(mock));
    await expect(client.read("orders/../../wp/v2/users" as never)).rejects.toThrow(new WooCommerceConfigError("the WooCommerce connector only reads its listed endpoints"));
    await expect(client.read("toString" as never)).rejects.toThrow(WooCommerceConfigError);
    await expect(client.read("orders", { consumer_key: KEY })).rejects.toThrow("the WooCommerce connector doesn't send consumer_key to /orders");
    await expect(client.read("customers", { email: "x" })).rejects.toThrow("doesn't send email");
    await expect(client.read("orders", { page: { nested: true } as never })).rejects.toThrow("page must be a plain value");
    await expect(client.read("variations", {})).rejects.toThrow("needs a numeric id");
    await expect(client.read("variations", {}, 1.5)).rejects.toThrow("needs a numeric id");
    await expect(client.read("variations", {}, -3)).rejects.toThrow("needs a numeric id");
    expect(mock.fetch.calls).toEqual([]);
    expect(Object.values(WOOCOMMERCE_ROUTES).map((r) => r.path)).toEqual(["/orders", "/products", "/products/{id}/variations", "/customers", "/refunds"]);
  });

  it("sends GET only, to the store it was given, with the keys in the Authorization header and redirects off", async () => {
    const mock = wooCommerceDocMock(store());
    const { fetch, sent } = recording(mock);
    const client = wooCommerceClient(options(mock, { fetch, storeUrl: `${WOOCOMMERCE_MOCK_STORE}/` }));
    const page = await client.read("orders", { per_page: 100, page: 1, status: "any" });
    await client.read("variations", { per_page: 100 }, 103);
    expect(page.items).toHaveLength(4);
    expect(page.totalPages).toBe(1);
    expect(sent.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(sent.map((s) => s.url)).toEqual([`${WOOCOMMERCE_MOCK_STORE}/wp-json/wc/v3/orders?per_page=100&page=1&status=any`, `${WOOCOMMERCE_MOCK_STORE}/wp-json/wc/v3/products/103/variations?per_page=100`]);
    expect(sent.every((s) => s.auth === `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}` && s.redirect === "manual")).toBe(true);
    expect(sent.some((s) => s.url.includes(KEY) || s.url.includes(SECRET) || s.url.includes("consumer"))).toBe(false);
  });

  it("stops on a redirect instead of following it, so the keys never leave the store", async () => {
    const mock = wooCommerceDocMock(store({ redirectTo: "https://elsewhere.example.test/wp-json/wc/v3/orders" }));
    const error = await failure(wooCommerceClient(options(mock)).read("orders"));
    expect(error).toBeInstanceOf(WooCommerceConfigError);
    expect(error.message).toContain("answered with a redirect");
    const opaque = wooCommerceClient(options(mock, { fetch: async () => Object.assign(new Response(null, { status: 200 }), {}) as Response }));
    expect(await failure(opaque.read("orders"))).toBeInstanceOf(WooCommerceApiError);
  });

  it("stops a Write-only key on its first read, and explains a bad key without echoing it", async () => {
    const writeOnly = await failure(wooCommerceClient(options(wooCommerceDocMock(store()), { consumerKey: WRITE_KEY, consumerSecret: WRITE_SECRET })).read("orders"));
    expect(writeOnly).toMatchObject({ status: 401, code: "woocommerce_rest_authentication_error" });
    expect(writeOnly.message).toContain("create a key with Read permission");
    const unknown = await failure(wooCommerceClient(options(wooCommerceDocMock(store({ keys: {} })))).read("orders"));
    expect(unknown.message).toContain("check the consumer key and secret");
    for (const e of [writeOnly, unknown]) expect(e.message.includes(KEY) || e.message.includes(SECRET) || e.message.includes(WRITE_SECRET)).toBe(false);
  });

  it("reports WooCommerce's errors cut short, with hints, and refuses an answer that isn't a list", async () => {
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => wooCommerceClient(options(wooCommerceDocMock(store()), { fetch: async () => new Response(JSON.stringify(body), { status, headers }) }));
    expect(await failure(answer(404, { code: "rest_no_route", message: "No route was found matching the URL and request method." }).read("refunds"))).toMatchObject({ code: "rest_no_route", message: expect.stringContaining("update WooCommerce") });
    expect(await failure(answer(403, { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources." }).read("orders"))).toMatchObject({ message: expect.stringContaining("administrator or shop manager") });
    const long = await failure(answer(500, { code: "Bad Code!", message: "x".repeat(5000) }).read("orders"));
    expect(long).toMatchObject({ status: 500, code: undefined });
    expect(long.message.length).toBeLessThan(120);
    const cut = await failure(answer(500, { code: "internal_server_error", message: "y".repeat(5000) }).read("orders"));
    expect(cut.message.length).toBeLessThan(300);
    expect(await failure(answer(502, "gateway").read("orders"))).toMatchObject({ status: 502 });
    expect(await failure(answer(200, { orders: [] }).read("orders"))).toThrow;
    await expect(answer(200, { orders: [] }).read("orders")).rejects.toThrow(new WooCommerceApiError("WooCommerce did not answer with a list", 200));
    const page = await answer(200, [{ id: 1 }, null, [1], "x"], { "x-wp-totalpages": "12345678" }).read("orders");
    expect(page).toEqual({ items: [{ id: 1 }], totalPages: null });
  });

  it("backs off on 429 with jitter, honours Retry-After up to a minute, then leaves the error to runSync", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const mock = wooCommerceDocMock(store({ rateLimits: [{ retryAfter: 2 }, { retryAfter: 600 }, {}] }));
    const page = await wooCommerceClient(options(mock, { sleep, random: () => 0.5 })).read("orders");
    expect(page.items).toHaveLength(4);
    expect(waits).toEqual([2000, 60_000, 4500]);
    const stuck = wooCommerceDocMock(store({ rateLimits: [{}, {}, {}, {}] }));
    expect(await failure(wooCommerceClient(options(stuck, { sleep })).read("orders"))).toMatchObject({ status: 429, code: "rate_limited" });
  });
});

describe("WooCommerce normalization", () => {
  const all = (data: WooCommerceMockData) => [
    ...(data.orders ?? []).flatMap((o) => wooOrderEvents(o, ctx())),
    ...(data.refunds ?? []).flatMap((r) => wooRefundEvents(r, ctx())),
    ...(data.products ?? []).flatMap((p) => wooProductEvents(p, data.variations?.[Number(p.id)] ?? null, ctx())),
    ...(data.customers ?? []).flatMap((c) => wooCustomerEvent(c, ctx()) ?? []),
  ];

  it("keeps nothing personal: no names, contact details, addresses, notes, IPs, user agents, transaction IDs, reasons or meta data", () => {
    const text = JSON.stringify(all(store()));
    for (const banned of ["example.test", "555", "Test Street", "Testville", "Customer 1", "testcustomer", "192.0.2.10", "Mozilla", "Synthetic note", "txn-test", "Synthetic reason", "engraving", "gift message", "order_key", "wc_order", "cart-test", "avatar", "ring_size"]) {
      expect(text, banned).not.toContain(banned);
    }
    // WooCommerce's own customer IDs never appear either.
    expect(text).not.toMatch(/customer:\d{1,6}"/);
    expect(text).not.toContain("customer_id");
  });

  it("gives a paid order the Shopify connector's order and sale events, and its payment in Stripe's shape", () => {
    reset();
    const order = wooOrder.one({ refunds: [{ id: 9001, total: "-50.00" }, { id: 9002, total: "-10.00" }] });
    const [updated, sale, payment] = wooOrderEvents(order, ctx());
    const customerId = wooCommerceCustomerRef(REF_KEY, HOST, 1);
    expect(updated).toEqual({
      id: "woocommerce_order:1001:2026-01-01T00:15:00",
      type: "order.updated",
      occurredAt: "2026-01-01T00:15:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "woocommerce:order:1001:2026-01-01T00:15:00",
      payload: {
        orderId: "woocommerce:order:1001",
        createdAt: "2026-01-01T00:10:00.000Z",
        status: "completed",
        paidAt: "2026-01-01T00:11:00.000Z",
        completedAt: "2026-01-01T00:14:00.000Z",
        cancelledAt: null,
        channel: "online",
        currency: "USD",
        totalCents: 120_000,
        lineCount: 1,
        linesComplete: true,
        customerId,
      },
    });
    expect(sale).toMatchObject({
      type: "sale.completed",
      idempotencyKey: "woocommerce:sale:1001",
      occurredAt: "2026-01-01T00:11:00.000Z",
      payload: { saleId: "woocommerce:order:1001", customerId, channel: "online", lines: [{ sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 125_000, discountCents: 5_000 }], totalCents: 120_000, payments: [{ method: "card", amountCents: 120_000 }] },
    });
    expect(payment).toMatchObject({
      type: "payment.charge_updated",
      idempotencyKey: "woocommerce:payment:1001:completed:6000",
      payload: { chargeId: "woocommerce:payment:1001", status: "completed", paid: true, captured: true, amountCents: 120_000, capturedCents: 120_000, refundedCents: 6_000, currency: "usd", method: "card", cardBrand: null, orderId: "woocommerce:order:1001", customerId },
    });
    // Later edits to the order store a new order.updated, never a second sale.
    const edited = wooOrderEvents({ ...order, ...wooDates("date_modified", "2026-01-05T00:00:00Z") }, ctx());
    expect(edited.map((e) => e.idempotencyKey)).toEqual(["woocommerce:order:1001:2026-01-05T00:00:00", "woocommerce:sale:1001", "woocommerce:payment:1001:completed:6000"]);
    // A point-of-sale order counts as the store; a cancelled one says when.
    expect(wooOrderEvents({ ...order, created_via: "pos-rest-api" }, ctx())[0]!.payload.channel).toBe("store");
    expect(wooOrderEvents({ ...order, status: "cancelled" }, ctx())[0]!.payload.cancelledAt).toBe("2026-01-01T00:15:00.000Z");
  });

  it("records a sale only once the money is taken and every line can be read", () => {
    reset();
    const types = (o: WooMockRecord) => wooOrderEvents(o, ctx()).map((e) => e.type);
    const unpaid = { date_paid: null, date_paid_gmt: null };
    expect(types(wooOrder.one({ status: "pending", ...unpaid }))).toEqual(["order.updated"]);
    expect(types(wooOrder.one({ status: "on-hold", ...unpaid }))).toEqual(["order.updated"]);
    expect(types(wooOrder.one({ status: "processing", ...unpaid }))).toEqual(["order.updated"]);
    expect(types(wooOrder.one({ status: "processing" }))).toEqual(["order.updated", "sale.completed", "payment.charge_updated"]);
    expect(types(wooOrder.one({ status: "on-hold" }))).toEqual(["order.updated", "payment.charge_updated"]);
    expect(types(wooOrder.one({ status: "refunded" }))).toEqual(["order.updated", "sale.completed", "payment.charge_updated"]);
    // Cash on delivery is paid when the order is completed, whether or not WooCommerce set a paid date.
    expect(types(wooOrder.one({ status: "completed", payment_method: "cod", ...unpaid }))).toEqual(["order.updated", "sale.completed"]);
    expect(types(wooOrder.one({ total: "0.00" }))).toEqual(["order.updated", "payment.charge_updated"]);
    expect(types(wooOrder.one({ total: "abc" }))).toEqual(["order.updated", "payment.charge_updated"]);
    expect(types(wooOrder.one({ line_items: [] }))).toEqual(["order.updated", "payment.charge_updated"]);
    for (const line of [{ quantity: 1.5 }, { quantity: 0 }, { quantity: -1 }, { subtotal: "n/a" }, { subtotal: "-5.00" }]) {
      const o = wooOrder.one();
      expect(types({ ...o, line_items: [{ ...(o.line_items as WooMockRecord[])[0], ...line }] }), JSON.stringify(line)).toEqual(["order.updated", "payment.charge_updated"]);
    }
    expect(wooOrderEvents({ id: 0 }, ctx())).toEqual([]);
    expect(wooOrderEvents({ id: "abc" }, ctx())).toEqual([]);
  });

  it("splits a line's price and discount, and gives lines without a SKU a stable stand-in", () => {
    reset();
    const order = wooOrder.one({
      total: "300.00",
      line_items: [
        { id: 1, product_id: 7, variation_id: 8, quantity: 3, subtotal: "100.00", total: "90.00", sku: " " },
        { id: 2, product_id: 7, variation_id: 0, quantity: 1, subtotal: "200.00", total: "210.00", sku: null },
        { id: 3, product_id: 0, variation_id: 0, quantity: 1, subtotal: "0.00", total: "0.00" },
      ],
    });
    expect(wooOrderEvents(order, ctx())[1]!.payload.lines).toEqual([
      { sku: "woocommerce-variation-8", quantity: 3, unitPriceCents: 3_333, discountCents: 1_000 },
      { sku: "woocommerce-product-7", quantity: 1, unitPriceCents: 20_000, discountCents: 0 },
      { sku: "woocommerce-line-1001-3", quantity: 1, unitPriceCents: 0, discountCents: 0 },
    ]);
  });

  it("maps WooCommerce payment methods to the sales department's", () => {
    const cases: [unknown, string][] = [
      ["cod", "cash"], ["cheque", "check"], ["bacs", "wire"], ["stripe", "card"], ["stripe_cc", "card"], ["woocommerce_payments", "card"], ["ppcp-gateway", "card"],
      ["square_credit_card", "card"], ["braintree_credit_card", "card"], ["authorize_net_cim_credit_card", "card"], ["affirm", "financing"], ["klarna_payments", "financing"],
      ["afterpay", "financing"], ["pw_gift_card", "gift_card"], ["layaway", "other"], ["", "other"], [undefined, "other"], ["Stripe!", "other"], [42, "other"], ["stripe".repeat(20), "other"],
    ];
    for (const [method, expected] of cases) expect(wooPaymentMethod(method), String(method)).toBe(expected);
  });

  it("turns each refund into its money in Stripe's shape, and the lines it returned into sale.returned", () => {
    reset();
    const [money, returned] = wooRefundEvents(wooRefund.one(), ctx());
    expect(money).toEqual({
      id: "woocommerce_refund:9001",
      type: "payment.refund_updated",
      occurredAt: "2026-01-01T00:17:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "woocommerce:refund:9001",
      payload: { refundId: "woocommerce:refund:9001", chargeId: "woocommerce:payment:1001", orderId: "woocommerce:order:1001", amountCents: 5_000, status: "succeeded", refundedPayment: true, reason: null },
    });
    expect(returned).toMatchObject({ type: "sale.returned", idempotencyKey: "woocommerce:return:9001", payload: { saleId: "woocommerce:order:1001", returnId: "woocommerce:refund:9001", lines: [{ sku: "SKU-TEST-0001", quantity: 1, refundCents: 5_000 }] } });
    // An amount-only refund has no lines; a manual one says so.
    expect(wooRefundEvents(wooRefund.one({ line_items: [], refunded_payment: false }), ctx()).map((e) => [e.type, e.payload.refundedPayment])).toEqual([["payment.refund_updated", false]]);
    expect(wooRefundEvents(wooRefund.one({ line_items: [{ quantity: 0, total: "0" }] }), ctx())).toHaveLength(1);
    expect(wooRefundEvents({ id: 5 }, ctx())).toEqual([]);
    expect(wooRefundEvents({ parent_id: 5 }, ctx())).toEqual([]);
  });

  it("gives products and their variations the Shopify connector's product shape, and counts managed stock", () => {
    reset();
    const simple = wooProduct.one();
    const [product, count] = wooProductEvents(simple, null, ctx());
    expect(product).toMatchObject({
      type: "product.updated",
      occurredAt: "2026-01-01T00:02:00.000Z",
      payload: { productId: "woocommerce:product:101", title: "Test 14K Ring 1", status: "publish", vendor: null, productType: "simple", tags: ["Bridal"], variants: [{ variantId: "woocommerce:product:101", sku: "SKU-TEST-0001", priceCents: 125_000, inventoryQuantity: 1 }] },
    });
    expect(product!.idempotencyKey).toMatch(/^woocommerce:product:101:2026-01-01T00:02:00:[0-9a-f]{12}$/);
    expect(count).toEqual({
      id: "woocommerce_count:product:101:2026-01-01T00:02:00.000Z:1",
      type: "inventory.counted",
      occurredAt: "2026-01-01T00:02:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "woocommerce:count:product:101:2026-01-01T00:02:00.000Z:1",
      payload: { sku: "SKU-TEST-0001", onHand: 1, variantId: "woocommerce:product:101", productId: "woocommerce:product:101" },
    });
    const variable = wooProduct.one({ type: "variable", manage_stock: true, stock_quantity: 4, sku: "PARENT-TEST" });
    const variations = [wooVariation.one(), wooVariation.one({ sku: "", manage_stock: "parent", stock_quantity: 9 }), wooVariation.one({ id: "bad" })];
    const events = wooProductEvents(variable, variations, ctx());
    expect(events[0]!.payload.variants).toEqual([
      { variantId: "woocommerce:variation:201", sku: "SKU-TEST-0001-V", priceCents: 98_000, inventoryQuantity: 2 },
      { variantId: "woocommerce:variation:202", sku: "woocommerce-variation-202", priceCents: 98_000, inventoryQuantity: null },
    ]);
    // The product keeps the stock its "parent" variations share; the managed variation counts its own.
    expect(events.slice(1).map((e) => [e.payload.sku, e.payload.onHand])).toEqual([["PARENT-TEST", 4], ["SKU-TEST-0001-V", 2]]);
    // A variation that changes without its product's date gives a new product event.
    const changed = wooProductEvents(variable, [{ ...variations[0]!, stock_quantity: 1 }, variations[1]!], ctx());
    expect(changed[0]!.idempotencyKey).not.toBe(events[0]!.idempotencyKey);
    // Untracked stock has no count; a negative or fractional one is kept as is, for the inventory schema to dead-letter.
    expect(wooProductEvents(wooProduct.one({ manage_stock: false }), null, ctx())).toHaveLength(1);
    expect(wooProductEvents(wooProduct.one({ stock_quantity: -2 }), null, ctx())[1]!.payload.onHand).toBe(-2);
    expect(wooProductEvents(wooProduct.one({ stock_quantity: 1.5 }), null, ctx())[1]!.payload.onHand).toBeNull();
    expect(wooProductEvents(wooProduct.one({ name: "", status: "Not A Slug", tags: "x" }), null, ctx())[0]!.payload).toMatchObject({ title: "WooCommerce product 106", status: null, tags: [] });
    expect(wooProductEvents({ id: null }, null, ctx())).toEqual([]);
  });

  it("makes customers profiles under a keyed reference, with consent never assumed", () => {
    reset();
    const customer = wooCustomer.one();
    const ref = wooCommerceCustomerRef(REF_KEY, HOST, 1)!;
    expect(ref).toMatch(/^woocommerce:customer:[0-9a-f]{32}$/);
    expect(wooCustomerEvent(customer, ctx())).toEqual({
      id: `woocommerce_customer:${ref.slice(21)}:2026-01-01T00:04:00.000Z`,
      type: "customer.profile_updated",
      occurredAt: "2026-01-01T00:04:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: `woocommerce:customer:${ref.slice(21)}:2026-01-01T00:04:00.000Z`,
      payload: { customerId: ref, name: `WooCommerce customer ${ref.slice(21, 29)}`, marketingConsent: false },
    });
    // Never modified: its creation stands in.
    expect(wooCustomerEvent({ ...customer, date_modified_gmt: null }, ctx())!.occurredAt).toBe("2026-01-01T00:03:00.000Z");
    expect(wooCustomerEvent({ id: 0 }, ctx())).toBeNull();
  });

  it("keys customer references with CUSTOMER_REF_KEY and the store, so they link up but can't be looked up without the key", () => {
    const ref = wooCommerceCustomerRef(REF_KEY, HOST, 7);
    expect(wooCommerceCustomerRef(REF_KEY, HOST, "7")).toBe(ref);
    expect(wooCommerceCustomerRef(OTHER_REF_KEY, HOST, 7)).not.toBe(ref);
    expect(wooCommerceCustomerRef(REF_KEY, "other-store.example.test", 7)).not.toBe(ref);
    expect(wooCommerceCustomerRef(REF_KEY, HOST, 8)).not.toBe(ref);
    for (const id of [0, -1, 1.5, "abc", "", null, undefined, {}, "1".repeat(20), Number.MAX_SAFE_INTEGER + 2]) expect(wooCommerceCustomerRef(REF_KEY, HOST, id), String(id)).toBeUndefined();
    expect(() => wooCommerceCustomerRef("short", HOST, 7)).toThrow(WooCommerceCustomerKeyError);
    expect(() => connector(wooCommerceDocMock(store()), { customerKey: " " })).toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });

  it("reads WooCommerce's times, money and quantities, and dead-letters what it can't", () => {
    // A _gmt time has no zone suffix; it is GMT whatever the server's own time zone.
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(wooTime("2026-01-01T10:00:00")).toBe("2026-01-01T10:00:00.000Z");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    expect(wooTime("2026-01-01T10:00:00.5")).toBe("2026-01-01T10:00:00.500Z");
    expect(wooTime("2026-01-01T10:00:00+02:00")).toBe("2026-01-01T08:00:00.000Z");
    for (const bad of ["", "2026-01-01", "2026-13-01T00:00:00", "yesterday", null, 5, `2026-01-01T10:00:00${"0".repeat(40)}`]) expect(wooTime(bad), String(bad)).toBeUndefined();
    expect([wooCents("125.50"), wooCents("125.5"), wooCents("125"), wooCents("-50.00"), wooCents("-0.00"), wooCents("0.005"), wooCents("0.994"), wooCents(12.3), wooCents(" 7.10 ")]).toEqual([12_550, 12_550, 12_500, -5_000, 0, 1, 99, 1_230, 710]);
    for (const bad of ["1,000.00", "$5", "1e3", "", null, undefined, Number.NaN, "1".repeat(30), {}]) expect(wooCents(bad), String(bad)).toBeNull();
    expect([wooQuantity(3), wooQuantity(-2), wooQuantity(1.5), wooQuantity("3"), wooQuantity(null)]).toEqual([3, -2, null, null, null]);
    reset();
    const timeless = wooOrderEvents({ ...wooOrder.one(), date_modified_gmt: undefined }, ctx())[0]!;
    expect([timeless.occurredAt, timeless.idempotencyKey.endsWith(":unknown")]).toEqual([undefined, true]);
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(store())).not.toThrow();
  });

  it("runs its patterns in linear time on hostile input", () => {
    const started = performance.now();
    const hostile = "a".repeat(200_000);
    wooTime(`${"9".repeat(100_000)}T`);
    wooCents(`${"1".repeat(100_000)}.`);
    wooPaymentMethod(`${"stripe-".repeat(30_000)}!`);
    expect(() => checkWooCommerceStoreUrl(`https://${"a.".repeat(100_000)}com`)).toThrow();
    expect(() => checkWooCommerceStoreUrl(`https://shop.example.com/${"a/".repeat(100_000)}`)).toThrow();
    isPrivateAddress(`${"1:".repeat(100_000)}::`);
    isPrivateAddress("::ffff:1.2.3.4".padStart(60, "0"));
    verifyWooCommerceWebhook(HOOK_SECRET, "{}", `${"A".repeat(100_000)}!`);
    verifyWooCommerceWebhook(HOOK_SECRET, "{}", ` ${"A".repeat(43)}`.padEnd(99, "A"));
    wooCommerceDeliveryId(`${hostile}!`);
    wooOrderEvents({ id: 1, status: hostile, created_via: `${"pos".repeat(60_000)}!`, payment_method: hostile, currency: hostile, line_items: [{ sku: hostile, quantity: 1, subtotal: hostile }] }, ctx());
    wooProductEvents({ id: 1, name: hostile, status: `${"a-".repeat(100_000)}!`, type: hostile, tags: [{ name: hostile }] }, null, ctx());
    expect(() => parseWooCommerceCursor(JSON.stringify({ pass: "historical", step: "orders", page: 1, after: `${"9".repeat(100_000)}T`, since: {}, latest: {} }))).toThrow();
    expect(() => parseWooCommerceCursor(`{"pass":"historical","after":"${"2026-01-01T00:00:00".repeat(300)}"}`)).toThrow();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("WooCommerce sync", () => {
  it("imports, replays, resumes and retries the mocked store", async () => {
    // Products: a tracked simple product (product and count), an untracked one, and a variable one with one tracked variation (product and count): 5.
    // Orders: a paid sale (order, sale, payment), a pending one, an unpaid cash-on-delivery one, and a paid guest sale (3): 8.
    // Refunds: one with a line (money and return), one for an amount only: 3. Customers: 3, and one without times, dead-lettered.
    const result = await checkConnectorSync({ makeConnector: () => connector(wooCommerceDocMock(store())), expected: { ingested: 19, deadLettered: 1 } });
    expect(result.full.batches).toBe(4);
    expect(parseWooCommerceCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", page: 1, after: null });
  });

  it("reads the whole catalog, five years of orders and refunds, and every customer, with the documented parameters", async () => {
    const mock = wooCommerceDocMock(store());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock)).toEqual(["/products", "/products/103/variations", "/orders", "/refunds", "/customers"]);
    const q = mock.fetch.calls.map((c) => queryOf(c.url));
    expect(q[0]).toEqual({ modified_after: "2000-01-01T00:00:00", dates_are_gmt: "true", orderby: "modified", order: "asc", status: "any", per_page: "100", page: "1" });
    expect(q[1]).toEqual({ per_page: "100", page: "1", orderby: "id", order: "asc" });
    expect(q[2]).toEqual({ modified_after: "2021-01-20T00:00:00", dates_are_gmt: "true", orderby: "modified", order: "asc", status: "any", per_page: "100", page: "1" });
    // The refunds list filters on local time, so it reaches a day further back.
    expect(q[3]).toEqual({ after: "2021-01-19T00:00:00", orderby: "date", order: "asc", per_page: "100", page: "1" });
    expect(q[4]).toEqual({ role: "all", per_page: "100", page: "1", orderby: "id", order: "asc" });
    const guest = memory.events.find((e) => e.idempotencyKey === "woocommerce:sale:1004")!;
    expect(guest.payload).toEqual({ saleId: "woocommerce:order:1004", channel: "online", lines: [{ sku: "woocommerce-variation-202", quantity: 2, unitPriceCents: 98_000, discountCents: 0 }], totalCents: 196_000, payments: [{ method: "cash", amountCents: 196_000 }] });
    expect(memory.events.filter((e) => e.type === "inventory.counted").map((e) => e.payload.sku).sort()).toEqual(["SKU-TEST-0001", "SKU-TEST-0001-V"]);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(wooCommerceDocMock(store())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 19, deadLettered: 1 });
    expect(new Set(memory.events.map((e) => e.type))).toEqual(
      new Set(["product.updated", "inventory.counted", "customer.profile_updated", "order.updated", "sale.completed", "sale.returned", "payment.charge_updated", "payment.refund_updated"]),
    );
    expect(memory.events.filter((e) => e.type === "sale.completed")).toHaveLength(2);
  });

  it("starts each page just after the newest change on the last, so nothing is skipped while orders change mid-import", async () => {
    reset();
    const orders = wooOrder.many(250, (n) => wooDates("date_modified", `2025-06-01T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00Z`));
    const data = store({ orders, refunds: [], products: [], customers: [] });
    const mock = wooCommerceDocMock(data);
    let served = 0;
    // After the first page, an order on it changes and moves to the end of the list.
    const { fetch } = recording(mock, (url) => {
      if (url.pathname.endsWith("/orders") && served++ === 1) Object.assign(orders[3]!, wooDates("date_modified", "2025-06-02T00:00:00Z"));
    });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const updated = new Set(memory.events.filter((e) => e.type === "order.updated").map((e) => e.payload.orderId));
    expect(updated.size).toBe(250);
    const afters = mock.fetch.calls.filter((c) => c.url.includes("/orders")).map((c) => [queryOf(c.url).modified_after, queryOf(c.url).page]);
    expect(afters).toEqual([
      ["2021-01-20T00:00:00", "1"],
      ["2025-06-01T01:39:59", "1"],
      ["2025-06-01T03:18:59", "1"],
    ]);
    expect(report.duplicates).toBeGreaterThan(0);
  });

  it("pages by number through more than a page of changes in the same second", async () => {
    reset();
    const same = wooDates("date_modified", "2025-06-01T00:00:00Z");
    const data = store({ orders: wooOrder.many(150, () => same), refunds: [], products: [], customers: [] });
    const mock = wooCommerceDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(new Set(memory.events.filter((e) => e.type === "order.updated").map((e) => e.payload.orderId)).size).toBe(150);
    expect(mock.fetch.calls.filter((c) => c.url.includes("/orders")).map((c) => [queryOf(c.url).modified_after, queryOf(c.url).page])).toEqual([
      ["2021-01-20T00:00:00", "1"],
      ["2025-05-31T23:59:59", "1"],
      ["2025-05-31T23:59:59", "2"],
    ]);
  });

  it("reads every page X-WP-TotalPages names, and every full page when a proxy drops it", async () => {
    reset();
    const customers = wooCustomer.many(250);
    for (const drop of [false, true]) {
      const mock = wooCommerceDocMock(store({ orders: [], refunds: [], products: [], customers, dropTotalHeaders: drop }));
      const { memory, pipeline } = testPipeline();
      await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
      expect(memory.events.filter((e) => e.type === "customer.profile_updated")).toHaveLength(250);
      expect(mock.fetch.calls.filter((c) => c.url.includes("/customers")).map((c) => queryOf(c.url).page)).toEqual(["1", "2", "3"]);
    }
    // Exactly a page and no header: one more read finds the end.
    const exact = wooCommerceDocMock(store({ orders: [], refunds: [], products: [], customers: customers.slice(0, 100), dropTotalHeaders: true }));
    await runSync({ connector: connector(exact), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(exact.fetch.calls.filter((c) => c.url.includes("/customers")).map((c) => queryOf(c.url).page)).toEqual(["1", "2"]);
  });

  it("reads every page of a product's variations", async () => {
    reset();
    const variable = wooProduct.one({ type: "variable", manage_stock: false });
    const variations = wooVariation.many(130);
    const mock = wooCommerceDocMock(store({ products: [variable], variations: { [Number(variable.id)]: variations }, orders: [], refunds: [], customers: [] }));
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(reads(mock).filter((p) => p.includes("variations"))).toHaveLength(2);
    expect((memory.events.find((e) => e.type === "product.updated")!.payload.variants as unknown[]).length).toBe(130);
    expect(memory.events.filter((e) => e.type === "inventory.counted")).toHaveLength(130);
  });

  it("leaves a finished import finished", async () => {
    const done: WooCommerceCursor = { pass: "historical", step: "done", page: 1, after: null, since: { products: "2000-01-01T00:00:00", orders: "2021-01-20T00:00:00", refunds: "2021-01-19T00:00:00", customers: "2021-01-20T00:00:00" }, latest: {} };
    const mock = wooCommerceDocMock(store());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads changes since the newest the import saw, less five minutes, and stops at customers it has seen", async () => {
    reset();
    const customers = wooCustomer.many(250);
    const data = store({ customers });
    const mock = wooCommerceDocMock(data);
    const { memory, pipeline } = testPipeline();
    const imported = await runSync({ connector: connector(mock), mode: "historical", memory, pipeline, organizationId: TEST_ORG });
    const latest = parseWooCommerceCursor(imported.cursor)!.latest;
    // Refunds are tracked on the store's local time, five hours behind GMT.
    expect(latest).toEqual({ products: "2026-01-01T00:04:00", orders: "2026-01-01T00:45:00", refunds: wooTimes("2026-01-01T00:27:00Z").local, customers: "2026-01-01T12:30:00" });
    // Each mode keeps its own checkpoint; an incremental pass that follows a finished one starts from it.
    await memory.saveCheckpoint(TEST_ORG, "woocommerce", "incremental", imported.cursor!);
    // A later pass: one new customer, registered after the import.
    customers.push(wooCustomer.one({ id: 999, ...wooDates("date_created", "2026-01-10T00:00:00Z") }));
    const later = wooCommerceDocMock(data);
    const report = await runSync({ connector: connector(later), mode: "incremental", memory, pipeline, organizationId: TEST_ORG });
    const calls = later.fetch.calls.map((c) => [new URL(c.url).pathname.replace("/wp-json/wc/v3", ""), queryOf(c.url)] as const);
    expect(calls.find(([p]) => p === "/products")![1]).toMatchObject({ modified_after: "2025-12-31T23:59:00" });
    expect(calls.find(([p]) => p === "/orders")![1]).toMatchObject({ modified_after: "2026-01-01T00:40:00", dates_are_gmt: "true" });
    expect(calls.find(([p]) => p === "/refunds")![1]).toMatchObject({ after: "2025-12-31T19:22:00" });
    const customerPages = calls.filter(([p]) => p === "/customers").map(([, q]) => q);
    // Newest first; the first page already reaches customers the import read, so the pass stops there.
    expect(customerPages).toEqual([{ role: "all", per_page: "100", page: "1", orderby: "registered_date", order: "desc" }]);
    expect(report.ingested).toBe(1);
    expect(parseWooCommerceCursor(report.cursor)).toMatchObject({ pass: "incremental", step: "done", latest: { customers: "2026-01-10T00:00:00" } });
  });

  it("pages back through new registrations until it reaches ones it has seen", async () => {
    reset();
    const customers = wooCustomer.many(250);
    const mock = wooCommerceDocMock(store({ customers, orders: [], refunds: [], products: [] }));
    const previous: WooCommerceCursor = {
      pass: "historical",
      step: "done",
      page: 1,
      after: null,
      since: { products: "2000-01-01T00:00:00", orders: "2021-01-20T00:00:00", refunds: "2021-01-19T00:00:00", customers: "2021-01-20T00:00:00" },
      latest: { customers: wooTimes(synthetic150()).gmt },
    };
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(previous) })) batches.push(b);
    expect(mock.fetch.calls.filter((c) => c.url.includes("/customers")).map((c) => queryOf(c.url).page)).toEqual(["1", "2"]);
  });

  it("looks back 48 hours on a first incremental sync, and resumes an interrupted pass where it stopped", async () => {
    const mock = wooCommerceDocMock(store());
    for await (const _ of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null })) break;
    expect(queryOf(mock.fetch.calls[0]!.url)).toMatchObject({ modified_after: "2026-01-18T00:00:00" });
    const resumed: WooCommerceCursor = { pass: "incremental", step: "refunds", page: 3, after: "2025-12-31T00:00:00", since: { products: "2026-01-18T00:00:00", orders: "2026-01-18T00:00:00", refunds: "2026-01-17T00:00:00", customers: "2026-01-18T00:00:00" }, latest: {} };
    const again = wooCommerceDocMock(store({ refunds: wooRefund.many(250) }));
    const first = await connector(again).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(resumed) })[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(reads(again)[0]).toBe("/refunds");
    expect(queryOf(again.fetch.calls[0]!.url)).toMatchObject({ after: "2025-12-31T00:00:00", page: "3" });
    // A pass with nothing new keeps its window for the next one; the refunds window is wider for local times.
    const quiet = wooCommerceDocMock(store({ orders: [], refunds: [], products: [], customers: [] }));
    const first2 = await runSync({ connector: connector(quiet), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(parseWooCommerceCursor(first2.cursor)!.since).toEqual({ products: "2026-01-18T00:00:00", orders: "2026-01-18T00:00:00", refunds: "2026-01-17T00:00:00", customers: "2026-01-18T00:00:00" });
  });

  it("stops when the store keeps rate-limiting, keeps the checkpoint where it was, and carries on from there", async () => {
    const data = store({ rateLimits: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] });
    const mock = wooCommerceDocMock(data);
    const { memory, pipeline } = testPipeline();
    const stopped = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ code: "rate_limited" });
    expect(await memory.getCheckpoint(TEST_ORG, "woocommerce", "historical")).toBeNull();
    const resumed = await runSync({ connector: connector(wooCommerceDocMock(store())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(resumed).toMatchObject({ ingested: 19, deadLettered: 1 });
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: WooCommerceCursor = { pass: "historical", step: "orders", page: 2, after: "2025-01-01T00:00:00", since: { products: "2000-01-01T00:00:00", orders: "2021-01-20T00:00:00", refunds: "2021-01-19T00:00:00", customers: "2021-01-20T00:00:00" }, latest: { orders: "2025-01-01T00:00:00" } };
    expect(parseWooCommerceCursor(JSON.stringify(good))).toEqual(good);
    expect(parseWooCommerceCursor(null)).toBeNull();
    const bad: unknown[] = [
      null,
      [],
      { ...good, pass: "full" },
      { ...good, step: "payments" },
      { ...good, step: "toString" },
      { ...good, page: 0 },
      { ...good, page: 1.5 },
      { ...good, page: 100_001 },
      { ...good, page: "2" },
      { ...good, after: "2025-01-01T00:00:00Z" },
      { ...good, after: "2025-01-01T00:00:00&per_page=1000" },
      { ...good, after: 5 },
      { ...good, since: { ...good.since, refunds: undefined } },
      { ...good, since: { ...good.since, orders: "yesterday" } },
      { ...good, since: [] },
      { ...good, latest: { orders: "2025-13-45T99:00:00" } },
      { ...good, latest: { payments: "2025-01-01T00:00:00" } },
      { ...good, latest: null },
    ];
    for (const c of bad) expect(() => parseWooCommerceCursor(JSON.stringify(c)), JSON.stringify(c)).toThrow("WooCommerce checkpoint is not in the expected shape");
    expect(() => parseWooCommerceCursor("x".repeat(5000))).toThrow("WooCommerce checkpoint is not in the expected shape");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(wooCommerceDocMock(store()));
    expect(c.writes).toBe(WOOCOMMERCE_WRITES);
    expect(WOOCOMMERCE_WRITES.map((w) => w.name)).toEqual(["update_stock", "update_product"]);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["update_stock", "refused"],
      ["update_product", "refused"],
    ]);
  });
});

/** The registration time of the 150th synthetic customer. */
function synthetic150(): string {
  reset();
  return String(wooCustomer.many(150).at(-1)!.date_created_gmt) + "Z";
}

describe("WooCommerce webhooks", () => {
  const deliveryAt = new Date("2026-01-01T06:00:00Z");

  it("accepts a delivery signed over the raw body, and rejects everything else, in constant time", () => {
    const body = JSON.stringify({ id: 1001, status: "completed" });
    const signature = hmacSha256(HOOK_SECRET, body, "base64");
    expect(verifyWooCommerceWebhook(HOOK_SECRET, body, signature)).toEqual({ ok: true });
    expect(verifyWooCommerceWebhook(HOOK_SECRET, Buffer.from(body), ` ${signature} `)).toEqual({ ok: true });
    expect(verifyWooCommerceWebhook(HOOK_SECRET, tamper(body), signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWooCommerceWebhook(`${HOOK_SECRET}x`, body, signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWooCommerceWebhook(HOOK_SECRET, body, hmacSha256(HOOK_SECRET, body, "hex"))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyWooCommerceWebhook(HOOK_SECRET, body, `${signature}=`)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyWooCommerceWebhook(HOOK_SECRET, body, "A".repeat(101))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyWooCommerceWebhook(HOOK_SECRET, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyWooCommerceWebhook("", body, signature)).toEqual({ ok: false, reason: "missing" });
    // A different body of the same length still fails.
    expect(verifyWooCommerceWebhook(HOOK_SECRET, body.replace("1001", "1002"), signature)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("handles each delivery ID once within the window, as WooCommerce signs no timestamp", () => {
    let clock = 0;
    const guard = new WooCommerceReplayGuard({ clock: () => clock, windowMs: 1000, maxEntries: 2 });
    expect(guard.firstDelivery("abc123")).toBe(true);
    expect(guard.firstDelivery("abc123")).toBe(false);
    clock = 999;
    expect(guard.firstDelivery("abc123")).toBe(false);
    clock = 1000;
    expect(guard.firstDelivery("abc123")).toBe(true);
    expect(guard.firstDelivery("def456")).toBe(true);
    expect(guard.firstDelivery("ghi789")).toBe(true);
    // Full: the oldest is forgotten first.
    expect(guard.firstDelivery("abc123")).toBe(true);
    for (const bad of [undefined, "", "x".repeat(65), "has space", "a/b"]) expect(guard.firstDelivery(bad), String(bad)).toBe(false);
    expect(new WooCommerceReplayGuard().firstDelivery("d".repeat(32))).toBe(true);
  });

  it("turns order, customer and simple product deliveries into the sync's own events, and the rest into prompts", () => {
    reset();
    const order = wooOrder.one(wooDates("date_modified", "2026-01-01T05:00:00Z"));
    const events = wooCommerceWebhookEvents({ topic: "order.updated", payload: order }, ctx(), deliveryAt);
    expect(events).toEqual(wooOrderEvents(order, ctx()));
    expect(events.map((e) => e.type)).toEqual(["order.updated", "sale.completed", "payment.charge_updated"]);
    const customer = wooCustomer.one(wooDates("date_modified", "2026-01-01T05:00:00Z"));
    expect(wooCommerceWebhookEvents({ topic: "customer.created", payload: customer }, ctx(), deliveryAt)).toEqual([wooCustomerEvent(customer, ctx())]);
    const product = wooProduct.one(wooDates("date_modified", "2026-01-01T05:00:00Z"));
    expect(wooCommerceWebhookEvents({ topic: "product.updated", payload: product }, ctx(), deliveryAt).map((e) => e.type)).toEqual(["product.updated", "inventory.counted"]);
    // A variable product's delivery lacks its variations; deletions, pings, unknown topics and guests give nothing.
    expect(wooCommerceWebhookEvents({ topic: "product.updated", payload: { ...product, type: "variable" } }, ctx(), deliveryAt)).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: "order.deleted", payload: { id: 1001 } }, ctx(), deliveryAt)).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: "order.updated", payload: "webhook_id=5" }, ctx(), deliveryAt)).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: "order.updated", payload: [order] }, ctx(), deliveryAt)).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: "coupon.updated", payload: order }, ctx(), deliveryAt)).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: undefined as never, payload: order }, ctx(), deliveryAt)).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: "customer.updated", payload: { ...customer, id: 0 } }, ctx(), deliveryAt)).toEqual([]);
  });

  it("gives no events for a delivery of a record last changed more than a day ago, so an old capture can't be replayed", () => {
    reset();
    const order = wooOrder.one(wooDates("date_modified", "2026-01-01T05:00:00Z"));
    const at = (ms: number) => new Date(Date.parse("2026-01-01T05:00:00Z") + ms);
    expect(wooCommerceWebhookEvents({ topic: "order.updated", payload: order }, ctx(), at(WOOCOMMERCE_STALE_DELIVERY_MS))).toHaveLength(3);
    expect(wooCommerceWebhookEvents({ topic: "order.updated", payload: order }, ctx(), at(WOOCOMMERCE_STALE_DELIVERY_MS + 1))).toEqual([]);
    expect(wooCommerceWebhookEvents({ topic: "order.updated", payload: { ...order, date_modified_gmt: null, date_created_gmt: null } }, ctx(), at(0))).toEqual([]);
  });

  it("stores a webhook for a record the sync already read, or a replayed one, as a duplicate", async () => {
    const data = store();
    const order = data.orders![0]!;
    const c = connector(wooCommerceDocMock(data), { now: () => new Date("2026-01-01T06:00:00Z") });
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(19);
    for (let i = 0; i < 2; i++) {
      const events = await c.handleWebhook!({ topic: "order.updated", payload: order });
      const results = await Promise.all(events.map((e) => pipeline.ingest({ ...(e as object), organizationId: TEST_ORG, source: "woocommerce" })));
      expect(results.map((r) => r.duplicate)).toEqual([true, true, true]);
    }
  });
});

describe("WooCommerce doc mock", () => {
  const basic = (key = KEY, secret = SECRET) => ({ authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}` });
  const get = async (mock: WooCommerceMock, path: string, headers: Record<string, string> = basic()) => {
    const response = await mock.fetch(`${WOOCOMMERCE_MOCK_STORE}/wp-json/wc/v3${path}`, { headers });
    return { status: response.status, body: (await response.json()) as unknown, pages: response.headers.get("x-wp-totalpages") };
  };

  it("answers like WooCommerce to requests the connector should never send", async () => {
    const mock = wooCommerceDocMock(store());
    expect(await get(mock, "/orders", {})).toMatchObject({ status: 401 });
    expect(await get(mock, "/orders", basic(KEY, WRITE_SECRET))).toMatchObject({ status: 401, body: { message: "Consumer secret is invalid." } });
    expect(await get(mock, "/orders", basic(WRITE_KEY, WRITE_SECRET))).toMatchObject({ status: 401, body: { message: "The API key provided does not have read permissions." } });
    expect(await get(mock, "/orders?per_page=101")).toMatchObject({ status: 400, body: { code: "rest_invalid_param" } });
    expect(await get(mock, "/orders?page=0")).toMatchObject({ status: 400 });
    expect(await get(mock, "/orders?page=2")).toMatchObject({ status: 400, body: { code: "rest_post_invalid_page_number" } });
    expect(await get(mock, "/customers?page=9")).toMatchObject({ status: 200, body: [] });
    expect(await get(mock, "/orders?orderby=price")).toMatchObject({ status: 400 });
    expect(await get(mock, "/orders?order=up")).toMatchObject({ status: 400 });
    expect(await get(mock, "/orders?status=shipped")).toMatchObject({ status: 400 });
    expect(await get(mock, "/orders?modified_after=yesterday")).toMatchObject({ status: 400 });
    expect(await get(mock, "/products/999/variations")).toMatchObject({ status: 404 });
    await expect(mock.fetch(`${WOOCOMMERCE_MOCK_STORE}/wp-json/wc/v3/orders`, { method: "POST", headers: basic() })).rejects.toThrow("is not in the vendor's docs");
    await expect(mock.fetch(`${WOOCOMMERCE_MOCK_STORE}/wp-json/wc/v3/system_status`, { headers: basic() })).rejects.toThrow("is not in the vendor's docs");
  });

  it("keeps the documented defaults: ten newest first, customers by name and role, filters exclusive", async () => {
    const data = store();
    reset();
    const all = wooOrder.many(12);
    const mock = wooCommerceDocMock({ ...data, orders: all, customers: [wooCustomer.one({ last_name: "Zed" }), wooCustomer.one({ last_name: "Abel" }), wooCustomer.one({ role: "subscriber" })] });
    const orders = await get(mock, "/orders");
    expect((orders.body as WooMockRecord[]).map((o) => o.id)).toEqual([1012, 1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004, 1003]);
    expect(orders.pages).toBe("2");
    expect(((await get(mock, "/customers")).body as WooMockRecord[]).map((c) => c.last_name)).toEqual(["Abel", "Zed"]);
    expect(((await get(mock, "/customers?role=all")).body as WooMockRecord[])).toHaveLength(3);
    // Exclusive, on local time unless dates_are_gmt says otherwise.
    const gmt = String(all[4]!.date_modified_gmt);
    const local = String(all[4]!.date_modified);
    expect(((await get(mock, `/orders?modified_after=${gmt}&dates_are_gmt=true&per_page=100`)).body as unknown[]).length).toBe(7);
    expect(((await get(mock, `/orders?modified_after=${local}&per_page=100`)).body as unknown[]).length).toBe(7);
    // A GMT time read as local reaches five hours later.
    expect(((await get(mock, `/orders?modified_after=${gmt}&per_page=100`)).body as unknown[]).length).toBe(0);
  });
});
