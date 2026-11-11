import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import {
  CIN7_DOC_PAGES,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  cin7Customer,
  cin7DocMock,
  cin7Guid,
  cin7MockTime,
  cin7Product,
  cin7Purchase,
  cin7Sale,
  cin7Stock,
  cin7Supplier,
  testPipeline,
  type Cin7Mock,
  type Cin7MockData,
} from "@karatos/connector-testkit";
import {
  CIN7_API_URL,
  CIN7_FIRST_LOOKBACK_MS,
  CIN7_MAX_PAGE,
  CIN7_OVERLAP_MS,
  CIN7_PAGE_SIZE,
  CIN7_SPACING_MS,
  CIN7_WRITES,
  Cin7ApiError,
  Cin7ConfigError,
  cin7Cents,
  cin7Client,
  cin7Connector,
  cin7CustomerEvent,
  cin7ProductEvent,
  cin7PurchaseEvent,
  cin7SaleEvent,
  cin7StockEvent,
  cin7SupplierEvent,
  cin7Time,
  parseCin7Cursor,
  type Cin7Client,
  type Cin7Cursor,
  type Cin7Event,
  type Cin7List,
  type Cin7Options,
} from "../src/index.js";

// GUID-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const ACCOUNT = [cin7Guid("f", 1).slice(0, 9), "1111-4111-8111-", "f".repeat(12)].join("");
const KEY = [cin7Guid("f", 2).slice(0, 9), "2222-4222-8222-", "d".repeat(12)].join("");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const BASE = "https://inventory.dearsystems.com/ExternalApi/v2";
const HOUR_MS = 3_600_000;
const FIVE_YEARS = "2021-11-11T15:00:00.000Z";
const noSleep = async () => {};

/** `ago` hours before NOW, as an ISO time. */
const before = (ago: number) => new Date(NOW().getTime() - ago * HOUR_MS).toISOString();
/** `ago` hours before NOW, as Cin7 Core writes a time. */
const cin7Before = (ago: number) => before(ago).slice(0, 19);

/** Two of each record, changed 1 and 30 hours ago, and a sale and purchase six years ago, past the five read. */
function account(overrides: Partial<Cin7MockData> = {}): Cin7MockData {
  for (const f of [cin7Product, cin7Customer, cin7Supplier, cin7Sale, cin7Purchase, cin7Stock]) f.reset();
  const ages = [1, 30];
  return {
    accountId: ACCOUNT,
    applicationKey: KEY,
    products: ages.map((ago) => cin7Product.one({ LastModifiedOn: cin7Before(ago) })),
    customers: ages.map((ago) => cin7Customer.one({ LastModifiedOn: cin7Before(ago) })),
    suppliers: ages.map((ago) => cin7Supplier.one({ LastModifiedOn: cin7Before(ago) })),
    sales: [...ages, 52_600].map((ago) => cin7Sale.one({ Updated: cin7Before(ago) })),
    purchases: [...ages, 52_600].map((ago) => cin7Purchase.one({ LastUpdatedDate: cin7Before(ago) })),
    stock: ages.map(() => cin7Stock.one()),
    ...overrides,
  };
}

const connector = (mock: Cin7Mock, overrides: Partial<Cin7Options> = {}) => cin7Connector({ accountId: ACCOUNT, applicationKey: KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as Cin7Event[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const PAGE = { Products: [], Total: 0, Page: 1 };
/** A client whose clock stands still unless a test moves it, so spacing waits show up in `slept`. */
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof cin7Client>[0]> = {}) => {
  const slept: number[] = [];
  const c = cin7Client({ accountId: ACCOUNT, applicationKey: KEY, fetch, sleep: async (ms) => void slept.push(ms), clock: () => 0, ...extra });
  return { c, slept };
};
const ctx = { receivedAt: RECEIVED };
const ALL_LISTS: Cin7List[] = ["products", "customers", "suppliers", "sales", "purchases", "stock"];

describe("Cin7 Core client", () => {
  it("checks the account id and key before sending anything", () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    for (const accountId of ["", "x", ACCOUNT.slice(1), `${ACCOUNT}0`, ACCOUNT.replace(/-/g, ""), ACCOUNT.replace("-", ""), `0${ACCOUNT}`, ACCOUNT.replace("f", "g")]) {
      expect(() => cin7Client({ accountId, applicationKey: KEY, fetch }), accountId).toThrow("CIN7_ACCOUNT_ID is missing or isn't a Cin7 Core account id");
    }
    for (const applicationKey of ["", KEY.slice(1), `${KEY} x`]) {
      expect(() => cin7Client({ accountId: ACCOUNT, applicationKey, fetch }), applicationKey).toThrow("CIN7_APPLICATION_KEY is missing or isn't a Cin7 Core application key");
    }
    expect(() => cin7Client({ accountId: ` ${ACCOUNT.toUpperCase()} `, applicationKey: ` ${KEY} `, fetch })).not.toThrow();
    expect(() => cin7Client({} as never)).toThrow(Cin7ConfigError);
    expect(() => cin7Client({ accountId: ACCOUNT } as never)).toThrow(Cin7ConfigError);
    expect(sent).toHaveLength(0);
  });

  it("reads each list by its own path and filter, 1,000 a page, with the id and key in their headers", async () => {
    const bodies = [
      { Products: [{ id: 1 }], Total: 5 },
      { CustomerList: [], Total: 0 },
      { SupplierList: [], Total: 0 },
      { SaleList: [{ id: 2 }], Total: 1 },
      { PurchaseList: [], Total: 0 },
      { ProductAvailabilityList: [{ id: 3 }], Total: 7 },
    ];
    const { fetch, sent } = scripted(...bodies.map((b) => json(200, b)));
    const { c } = client(fetch, { accountId: ` ${ACCOUNT} `, applicationKey: ` ${KEY} ` });
    expect(await c.page("products", "2026-11-01T00:00:00Z", 2)).toEqual({ rows: [{ id: 1 }], total: 5 });
    expect(await c.page("customers", null, 1)).toEqual({ rows: [], total: 0 });
    expect(await c.page("suppliers", before(2), 1)).toEqual({ rows: [], total: 0 });
    expect(await c.page("sales", before(3), 3)).toEqual({ rows: [{ id: 2 }], total: 1 });
    expect(await c.page("purchases", before(4), 1)).toEqual({ rows: [], total: 0 });
    expect(await c.page("stock", null, 1)).toEqual({ rows: [{ id: 3 }], total: 7 });
    const headers = { "api-auth-accountid": ACCOUNT, "api-auth-applicationkey": KEY, accept: "application/json" };
    const at = (iso: string) => encodeURIComponent(iso);
    expect(sent).toEqual([
      { url: `${BASE}/product?Page=2&Limit=1000&ModifiedSince=${at("2026-11-01T00:00:00.000Z")}&IncludeDeprecated=true`, method: "GET", headers },
      { url: `${BASE}/customer?Page=1&Limit=1000&IncludeDeprecated=true`, method: "GET", headers },
      { url: `${BASE}/supplier?Page=1&Limit=1000&ModifiedSince=${at(before(2))}&IncludeDeprecated=true`, method: "GET", headers },
      { url: `${BASE}/saleList?Page=3&Limit=1000&UpdatedSince=${at(before(3))}`, method: "GET", headers },
      { url: `${BASE}/purchaseList?Page=1&Limit=1000&UpdatedSince=${at(before(4))}`, method: "GET", headers },
      { url: `${BASE}/ref/productavailability?Page=1&Limit=1000`, method: "GET", headers },
    ]);
    expect(CIN7_API_URL).toBe(BASE);
    expect(CIN7_PAGE_SIZE).toBe(1000);
  });

  it("asks only for pages 1 to the most a pass reads, of a list it reads, from a time, and never stock from a time", async () => {
    const { fetch, sent } = scripted(json(200, PAGE));
    const { c } = client(fetch);
    for (const page of [0, -1, 1.5, CIN7_MAX_PAGE + 1, Number.NaN]) await expect(c.page("products", null, page)).rejects.toMatchObject({ message: `a products page must be 1 to ${CIN7_MAX_PAGE}`, status: 0 });
    for (const since of ["", "yesterday"]) await expect(c.page("sales", since, 1)).rejects.toMatchObject({ message: "a sales start must be a time, and stock takes none", status: 0 });
    await expect(c.page("stock", before(1), 1)).rejects.toMatchObject({ message: "a stock start must be a time, and stock takes none", status: 0 });
    await expect(c.page("orders" as Cin7List, null, 1)).rejects.toMatchObject({ message: "orders is not a list KaratOS reads", status: 0 });
    await expect(c.page(`${"x".repeat(40)}` as Cin7List, null, 1)).rejects.toMatchObject({ message: `${"x".repeat(20)} is not a list KaratOS reads` });
    await expect(c.page("toString" as Cin7List, null, 1)).rejects.toThrow("toString is not a list KaratOS reads");
    expect(sent).toHaveLength(0);
    expect(await c.page("products", null, CIN7_MAX_PAGE)).toEqual({ rows: [], total: 0 });
    expect(CIN7_MAX_PAGE).toBe(1000);
  });

  it("says when an answer has no list or no Total", async () => {
    for (const body of [null, [], "x", {}, { Products: {} }, { Products: {}, Total: 1 }, { Products: "x", Total: 1 }, { Products: [] }, { Products: [], Total: 1.5 }, { Products: [], Total: "1" }, { CustomerList: [], Total: 1 }]) {
      const { c } = client(scripted(json(200, body)).fetch);
      await expect(c.page("products", null, 1), JSON.stringify(body)).rejects.toMatchObject({ message: "Cin7 Core answered the products without the list and its Total", status: 200 });
    }
    const { c: notJson } = client(scripted(text(200, "<html>")).fetch);
    await expect(notJson.page("stock", null, 1)).rejects.toThrow("Cin7 Core answered the stock without the list and its Total");
  });

  it("explains a turned-down id or key, and reports other errors", async () => {
    for (const status of [401, 403]) {
      const { c } = client(scripted(json(status, [{ ErrorCode: status, Exception: "Method authentication failed" }])).fetch);
      await expect(c.page("products", null, 1)).rejects.toThrow(new Cin7ConfigError("Cin7 Core turned down CIN7_ACCOUNT_ID and CIN7_APPLICATION_KEY: check both, and that the API application is still there"));
    }
    for (const status of [206, 302, 400, 404, 405, 501]) {
      const { fetch, sent } = scripted(json(status, {}));
      const { c } = client(fetch);
      const error = await c.page("sales", null, 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Cin7ApiError);
      expect(error).toMatchObject({ message: `Cin7 Core answered HTTP ${status} for the sales`, status });
      expect(sent, String(status)).toHaveLength(1);
    }
  });

  it("waits out rate limits as Retry-After says, up to a minute, or backs off 5, 10 and 20 seconds, then gives up", async () => {
    const { fetch, sent } = scripted(json(503, [], { "Retry-After": "7" }), json(429, [], { "Retry-After": "600" }), json(200, PAGE));
    const { c, slept } = client(fetch);
    expect(await c.page("products", null, 1)).toEqual({ rows: [], total: 0 });
    expect(sent).toHaveLength(3);
    // Each retry is also spaced from the call before it, by the still clock.
    expect(slept).toEqual([7000, CIN7_SPACING_MS, 60_000, CIN7_SPACING_MS]);
    for (const status of [500, 502, 504]) {
      const { fetch: f, sent: s } = scripted(json(status, {}, { "Retry-After": "x" }));
      const { c: down, slept: waits } = client(f, { clock: () => 1e12 + 1e6 * s.length });
      await expect(down.page("products", null, 1)).rejects.toMatchObject({ message: `Cin7 Core answered HTTP ${status} for the products`, status });
      expect(s).toHaveLength(4);
      expect(waits).toEqual([5000, 10_000, 20_000]);
    }
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(json(400, {}));
    await expect(client(fetch).c.page("products", null, 1)).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(1);
    const { fetch: f, sent: s } = scripted(json(503, {}));
    await expect(client(f, { retries: 0 }).c.page("products", null, 1)).rejects.toMatchObject({ status: 503 });
    expect(s).toHaveLength(1);
    const { fetch: f2, sent: s2 } = scripted(json(503, {}));
    await expect(client(f2, { retries: 1 }).c.page("products", null, 1)).rejects.toMatchObject({ status: 503 });
    expect(s2).toHaveLength(2);
  });

  it("spaces its calls a second apart, and doesn't wait once a second has passed", async () => {
    let t = 50_000;
    const { fetch } = scripted(json(200, PAGE));
    const { c, slept } = client(fetch, { clock: () => t });
    await c.page("products", null, 1);
    expect(slept).toEqual([]);
    t += 300;
    await c.page("products", null, 2);
    expect(slept).toEqual([700]);
    t += CIN7_SPACING_MS;
    await c.page("products", null, 3);
    expect(slept).toEqual([700]);
    t += CIN7_SPACING_MS - 1;
    await c.page("products", null, 4);
    expect(slept).toEqual([700, 1]);
    expect(CIN7_SPACING_MS).toBe(1000);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(503, [], { "Retry-After": "0.001" }), json(200, PAGE));
    globalThis.fetch = fetch;
    const started = Date.now();
    try {
      expect(await cin7Client({ accountId: ACCOUNT, applicationKey: KEY }).page("products", null, 1)).toEqual({ rows: [], total: 0 });
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
    // The retry waits out the spacing from the first call.
    expect(Date.now() - started).toBeGreaterThanOrEqual(CIN7_SPACING_MS - 50);
  });

  it("only ever sends GETs to the six lists", async () => {
    const mock = cin7DocMock(account());
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.map((r) => r.list)).toEqual(ALL_LISTS);
    expect(mock.api.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /product", "GET /customer", "GET /supplier", "GET /saleList", "GET /purchaseList", "GET /ref/productavailability"]);
  });
});

describe("Cin7 Core events", () => {
  const product = (extra: Record<string, unknown> = {}) => {
    cin7Product.reset();
    return cin7Product.one({ LastModifiedOn: cin7Before(1), ...extra });
  };

  it("reads UTC times with or without the Z, and money in whole cents", () => {
    expect(cin7Time("2026-03-04T05:06:07")).toBe("2026-03-04T05:06:07.000Z");
    expect(cin7Time("2026-03-04T05:06:07Z")).toBe("2026-03-04T05:06:07.000Z");
    expect(cin7Time("2026-03-04T05:06:07.1234567")).toBe("2026-03-04T05:06:07.123Z");
    expect(cin7Time("2026-03-04T05:06:07.123Z")).toBe("2026-03-04T05:06:07.123Z");
    expect(cin7Time("2026-03-04T05:06:07.12345678")).toBe("2026-03-04T05:06:07.123Z");
    for (const bad of ["2026-02-30T00:00:00", "2026-03-04 05:06:07", "2026-03-04T05:06:07+01:00", "2026-03-04T05:06:07.1234567890", "2026-03-04", "x2026-03-04T05:06:07", "2026-03-04T05:06:07ZZ", 1, null]) expect(cin7Time(bad), String(bad)).toBeNull();
    expect(cin7Cents(1250.5)).toBe(125_050);
    expect(cin7Cents(0.015)).toBe(2);
    expect(cin7Cents(-3)).toBe(-300);
    expect(cin7Cents(1e12)).toBe(1e14);
    for (const bad of ["12", 1e12 + 1, -1e12 - 1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) expect(cin7Cents(bad), String(bad)).toBeUndefined();
  });

  it("logs a product with its sku, name, kind, price and cost, dated by its change", () => {
    const { ok, event } = cin7ProductEvent(product(), ctx);
    expect(ok).toBe(true);
    const id = cin7Guid("a", 1);
    expect(event).toMatchObject({ type: "product.updated", occurredAt: before(1), receivedAt: RECEIVED });
    expect(event.payload).toEqual({
      system: "Cin7 Core",
      productId: `cin7:product:${id}`,
      sku: "RING-14K-001",
      name: "Test solitaire ring 1",
      category: "Rings",
      brand: "Test Brand",
      kind: "stock",
      unit: "Item",
      priceCents: 125_050,
      averageCostCents: 41_025,
      active: true,
      changedAt: before(1),
    });
    expect(event.idempotencyKey).toMatch(new RegExp(`^cin7:product:${id}:[0-9a-f]{12}$`));
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    expect(JSON.stringify(event)).not.toContain("Test ring");
  });

  it("reads a deprecated product as inactive, keeps ids in lower case, and leaves out what doesn't read", () => {
    const upper = cin7Guid("a", 1).toUpperCase();
    const { ok, event } = cin7ProductEvent(product({ ID: upper, Status: "Deprecated", Name: "<b>ring</b>", Category: " ", Brand: "x".repeat(101), Type: "Non-Inventory", UOM: 5, PriceTier1: "12", AverageCost: null }), ctx);
    expect(ok).toBe(true);
    expect(event.payload).toMatchObject({ productId: `cin7:product:${cin7Guid("a", 1)}`, active: false, kind: "non_inventory" });
    for (const field of ["name", "category", "brand", "unit", "priceCents", "averageCostCents"]) expect(event.payload[field], field).toBeUndefined();
    expect(cin7ProductEvent(product({ Status: "Active " }), ctx).event.payload.active).toBe(true);
    expect(cin7ProductEvent(product({ Status: undefined }), ctx).event.payload.active).toBe(true);
    expect(cin7ProductEvent(product({ Type: "Stock 2" }), ctx).event.payload.kind).toBe("stock_2");
    expect(cin7ProductEvent(product({ Type: "9 Stock" }), ctx).event.payload.kind).toBeUndefined();
    expect(cin7ProductEvent(product({ Type: "Stock!" }), ctx).event.payload.kind).toBeUndefined();
    expect(cin7ProductEvent(product({ Name: "x".repeat(200) }), ctx).event.payload.name).toBe("x".repeat(200));
    expect(cin7ProductEvent(product({ Category: "x".repeat(100) }), ctx).event.payload.category).toBe("x".repeat(100));
    expect(cin7ProductEvent(product({ Category: "x".repeat(101) }), ctx).event.payload.category).toBeUndefined();
    expect(cin7ProductEvent(product({ Name: "x".repeat(201) }), ctx).event.payload.name).toBeUndefined();
    expect(cin7ProductEvent(product({ Name: "ring\u0007" }), ctx).event.payload.name).toBeUndefined();
    expect(cin7ProductEvent(product({ Name: "  ring  " }), ctx).event.payload.name).toBe("ring");
    expect(cin7ProductEvent(product({ Name: "ring > band" }), ctx).event.payload.name).toBeUndefined();
  });

  it("logs customers and suppliers by name, currency and whether they're active, never how to reach them", () => {
    cin7Customer.reset();
    cin7Supplier.reset();
    const customer = cin7CustomerEvent(cin7Customer.one({ LastModifiedOn: cin7Before(2) }), ctx);
    expect(customer.ok).toBe(true);
    expect(customer.event).toMatchObject({ type: "customer.profile_updated", occurredAt: before(2) });
    expect(customer.event.payload).toEqual({ system: "Cin7 Core", customerId: `cin7:customer:${cin7Guid("b", 1)}`, name: "Test Boutique 1", currency: "USD", active: true, changedAt: before(2) });
    const supplier = cin7SupplierEvent(cin7Supplier.one({ LastModifiedOn: cin7Before(3), Currency: " eur ", Status: "Deprecated" }), ctx);
    expect(supplier.event).toMatchObject({ type: "accounting.vendor_updated", occurredAt: before(3) });
    expect(supplier.event.payload).toEqual({ system: "Cin7 Core", vendorId: `cin7:supplier:${cin7Guid("c", 1)}`, name: "Test Casting 1", currency: "EUR", active: false, changedAt: before(3) });
    for (const e of [customer.event, supplier.event]) {
      const all = JSON.stringify(e);
      for (const hidden of ["Test Street", "example.test", "555", "Testville", "rose gold", "Test Customer"]) expect(all, hidden).not.toContain(hidden);
    }
    const nameless = cin7CustomerEvent(cin7Customer.one({ Name: "<x>", Currency: "US", LastModifiedOn: cin7Before(1) }), ctx);
    expect(nameless.event.payload).toMatchObject({ name: `Cin7 Core customer ${cin7Guid("b", 2)}`, currency: undefined });
    expect(cin7SupplierEvent(cin7Supplier.one({ Name: undefined, Currency: 978, LastModifiedOn: cin7Before(1) }), ctx).event.payload).toMatchObject({ name: `Cin7 Core supplier ${cin7Guid("c", 2)}`, currency: undefined });
    expect(cin7CustomerEvent(cin7Customer.one({ Name: "x".repeat(256), LastModifiedOn: cin7Before(1) }), ctx).event.payload.name).toBe("x".repeat(256));
    expect(cin7CustomerEvent(cin7Customer.one({ Name: "x".repeat(257), LastModifiedOn: cin7Before(1) }), ctx).event.payload.name).toMatch(/^Cin7 Core customer /);
    expect(cin7CustomerEvent(cin7Customer.one({ Currency: "USDX", LastModifiedOn: cin7Before(1) }), ctx).event.payload.currency).toBeUndefined();
  });

  it("logs a sale with its numbers, customer, status, dates, and what is paid and owed", () => {
    cin7Sale.reset();
    const { ok, event } = cin7SaleEvent(cin7Sale.one({ Updated: cin7Before(4) }), ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: "order.updated", occurredAt: before(4) });
    expect(event.payload).toEqual({
      system: "Cin7 Core",
      orderId: `cin7:sale:${cin7Guid("d", 1)}`,
      number: "SO-00001",
      invoiceNumber: "INV-00001",
      customerId: `cin7:customer:${cin7Guid("b", 1)}`,
      status: "invoiced",
      orderDate: "2026-01-01",
      invoiceDate: "2026-01-02",
      dueDate: "2026-02-01",
      totalCents: 250_000,
      paidCents: 100_000,
      balanceCents: 150_000,
      currency: "USD",
      changedAt: before(4),
    });
    const odd = cin7SaleEvent(cin7Sale.one({ Updated: cin7Before(4), OrderNumber: "SO 1", InvoiceNumber: null, CustomerID: "nope", Status: "BACKORDERED", OrderDate: "2026-02-30T00:00:00", InvoiceDate: "2026-01-02", InvoiceDueDate: "2026-01-02T00:00:00Z", PaidAmount: null, CustomerCurrency: "gbp" }), ctx);
    expect(odd.event.payload).toMatchObject({ number: undefined, invoiceNumber: undefined, customerId: undefined, status: "backordered", orderDate: undefined, invoiceDate: "2026-01-02", dueDate: "2026-01-02", totalCents: 250_000, paidCents: undefined, balanceCents: undefined, currency: "GBP" });
    expect(cin7SaleEvent(cin7Sale.one({ Updated: cin7Before(4), InvoiceAmount: "9", PaidAmount: 1 }), ctx).event.payload).toMatchObject({ totalCents: undefined, paidCents: 100, balanceCents: undefined });
    for (const bad of ["2026-01-02T00:00", "2026-1-02", "x2026-01-02", "2026-01-02x", "2026-13-01"]) expect(cin7SaleEvent(cin7Sale.one({ Updated: cin7Before(4), OrderDate: bad }), ctx).event.payload.orderDate, bad).toBeUndefined();
    expect(cin7SaleEvent(cin7Sale.one({ Updated: cin7Before(4), OrderDate: "2026-01-02T00:00:00.1234567" }), ctx).event.payload.orderDate).toBe("2026-01-02");
  });

  it("logs a purchase with its supplier, required-by date, and what is still owed", () => {
    cin7Purchase.reset();
    const { ok, event } = cin7PurchaseEvent(cin7Purchase.one({ LastUpdatedDate: cin7Before(5), PaidAmount: 250.5 }), ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: "accounting.purchase_order_updated", occurredAt: before(5) });
    expect(event.payload).toEqual({
      system: "Cin7 Core",
      purchaseOrderId: `cin7:purchase:${cin7Guid("e", 1)}`,
      number: "PO-00001",
      invoiceNumber: undefined,
      vendorId: `cin7:supplier:${cin7Guid("c", 1)}`,
      status: "ordered",
      orderDate: "2026-01-03",
      requiredBy: "2026-01-20",
      dueDate: undefined,
      totalCents: 90_000,
      paidCents: 25_050,
      balanceCents: 64_950,
      currency: "USD",
      changedAt: before(5),
    });
  });

  it("logs stock as a count for each product at each location, bin and batch", () => {
    cin7Stock.reset();
    const { ok, event } = cin7StockEvent(cin7Stock.one(), ctx);
    expect(ok).toBe(true);
    expect(event).toMatchObject({ type: "inventory.counted", occurredAt: RECEIVED, receivedAt: RECEIVED });
    expect(event.payload).toEqual({ system: "Cin7 Core", sku: "RING-14K-001", onHand: 3, productId: `cin7:product:${cin7Guid("a", 1)}`, location: "Main Store", bin: undefined, batch: undefined, allocated: 1, available: 2, onOrder: 0 });
    expect(event.idempotencyKey).toMatch(new RegExp(`^cin7:stock:${cin7Guid("a", 1)}_[0-9a-f]{12}:[0-9a-f]{12}$`));
    cin7Stock.reset();
    const plain = cin7StockEvent(cin7Stock.one(), ctx).event.idempotencyKey.split(":")[2];
    const splits = [{ Bin: "A1" }, { Batch: "B7" }, { Bin: "A1", Batch: "B7" }, { Location: "Safe" }].map((extra) => {
      cin7Stock.reset();
      return cin7StockEvent(cin7Stock.one(extra), ctx).event;
    });
    expect(new Set([plain, ...splits.map((e) => e.idempotencyKey.split(":")[2])]).size).toBe(5);
    expect(splits[2]!.payload).toMatchObject({ bin: "A1", batch: "B7" });
    cin7Stock.reset();
    expect(cin7StockEvent(cin7Stock.one({ Location: "x".repeat(256) }), ctx).ok).toBe(true);
    cin7Stock.reset();
    expect(cin7StockEvent(cin7Stock.one({ Location: "x".repeat(257) }), ctx).ok).toBe(false);
    cin7Stock.reset();
    expect(cin7StockEvent(cin7Stock.one({ OnHand: 0, Allocated: "1", Available: -1, OnOrder: 2.5 }), ctx).event.payload).toMatchObject({ onHand: 0, allocated: undefined, available: -1, onOrder: 2.5 });
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const a = cin7ProductEvent(product(), ctx).event;
    const b = cin7ProductEvent(product(), { receivedAt: before(9) }).event;
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    expect(cin7ProductEvent(product({ PriceTier1: 1300 }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(cin7ProductEvent(product({ LastModifiedOn: cin7Before(2) }), ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
    cin7Stock.reset();
    const s = cin7StockEvent(cin7Stock.one(), ctx).event;
    cin7Stock.reset();
    expect(cin7StockEvent(cin7Stock.one({ OnHand: 4 }), ctx).event.idempotencyKey).not.toBe(s.idempotencyKey);
  });

  it("dead-letters a record it can't read, saying why", () => {
    const cases: [ReturnType<typeof cin7ProductEvent>, string, string[]][] = [
      [cin7ProductEvent(null, ctx), "product", ["product is not an object", "product has no id that reads", "product has no change time that reads", "product has no sku that reads"]],
      [cin7ProductEvent([], ctx), "product", ["product is not an object", "product has no id that reads", "product has no change time that reads", "product has no sku that reads"]],
      [cin7ProductEvent(product({ ID: "not-a-guid" }), ctx), "product", ["product has no id that reads"]],
      [cin7ProductEvent(product({ ID: `x${cin7Guid("a", 1)}` }), ctx), "product", ["product has no id that reads"]],
      [cin7ProductEvent(product({ ID: `${cin7Guid("a", 1)}0` }), ctx), "product", ["product has no id that reads"]],
      [cin7ProductEvent(product({ ID: cin7Guid("a", 1).replace("-0000-", "-") }), ctx), "product", ["product has no id that reads"]],
      [cin7ProductEvent(product({ LastModifiedOn: "yesterday" }), ctx), "product", ["product has no change time that reads"]],
      [cin7ProductEvent(product({ SKU: "RING 1" }), ctx), "product", ["product has no sku that reads"]],
      [cin7CustomerEvent({ ID: cin7Guid("b", 9) }, ctx), "customer", ["customer has no change time that reads"]],
      [cin7SupplierEvent({ LastModifiedOn: cin7Before(1) }, ctx), "supplier", ["supplier has no id that reads"]],
      [cin7SaleEvent({ ID: cin7Guid("d", 9), Updated: cin7Before(1) }, ctx), "sale", ["sale has no id that reads"]],
      [cin7PurchaseEvent({ ID: cin7Guid("e", 9), Updated: cin7Before(1) }, ctx), "purchase", ["purchase has no change time that reads"]],
      [cin7StockEvent("x", ctx), "stock", ["stock is not an object", "stock has no product and location that read", "stock's product has no sku that reads", "stock on hand isn't a whole count of zero or more"]],
      [cin7StockEvent({ ID: cin7Guid("a", 9), SKU: "R-1", OnHand: 1 }, ctx), "stock", ["stock has no product and location that read"]],
      [cin7StockEvent({ ID: cin7Guid("a", 9), SKU: "R-1", OnHand: undefined, Location: "Main" }, ctx), "stock", ["stock on hand isn't a whole count of zero or more"]],
      [cin7StockEvent({ Location: "Main", SKU: "R-1", OnHand: 1 }, ctx), "stock", ["stock has no product and location that read"]],
      [cin7StockEvent({ ID: cin7Guid("a", 9), Location: "Main", SKU: "R-1", OnHand: 1.5 }, ctx), "stock", ["stock on hand isn't a whole count of zero or more"]],
      [cin7StockEvent({ ID: cin7Guid("a", 9), Location: "Main", SKU: "R-1", OnHand: -1 }, ctx), "stock", ["stock on hand isn't a whole count of zero or more"]],
      [cin7StockEvent({ ID: cin7Guid("a", 9), Location: "Main", SKU: "R-1", OnHand: "1" }, ctx), "stock", ["stock on hand isn't a whole count of zero or more"]],
      [cin7StockEvent({ ID: cin7Guid("a", 9), Location: "Main", SKU: "R-1", OnHand: 1e16 }, ctx), "stock", ["stock on hand isn't a whole count of zero or more"]],
    ];
    for (const [read, kind, problems] of cases) {
      expect(read.ok, problems.join()).toBe(false);
      expect(read.event.occurredAt).toBeUndefined();
      expect(read.event.payload).toMatchObject({ system: "Cin7 Core", kind, problems });
      expect(read.event.idempotencyKey).toMatch(new RegExp(`^cin7:unreadable_${kind}:[0-9a-f]{12}$`));
    }
    expect(cin7ProductEvent(product({ ID: "not-a-guid" }), ctx).event.payload.id).toBeNull();
    expect(cin7ProductEvent(product({ SKU: "" }), ctx).event.payload.id).toBe(cin7Guid("a", 1));
    expect(cin7StockEvent({ ID: cin7Guid("a", 9), SKU: "R-1", OnHand: 1 }, ctx).event.payload.id).toBeNull();
    expect(cin7StockEvent({ ID: cin7Guid("a", 9), Location: "Main", SKU: "R-1", OnHand: 1.5 }, ctx).event.payload.id).toMatch(new RegExp(`^${cin7Guid("a", 9)}_`));
    // Two records that don't read are two dead letters.
    expect(cin7ProductEvent({ ID: 1 }, ctx).event.idempotencyKey).not.toBe(cin7ProductEvent({ ID: 2 }, ctx).event.idempotencyKey);
  });
});

describe("Cin7 Core checkpoint", () => {
  const marks = { products: null, customers: before(1), suppliers: null, sales: before(2), purchases: null };
  const good: Cin7Cursor = { done: false, marks, pass: { list: "sales", since: before(9), page: 3, began: before(1) } };

  it("round-trips and turns down any other shape", () => {
    expect(parseCin7Cursor(null)).toBeNull();
    expect(parseCin7Cursor(JSON.stringify(good))).toEqual(good);
    for (const pass of [null, { list: "products", since: null, page: 1, began: before(1) }, { list: "stock", since: null, page: CIN7_MAX_PAGE, began: before(1) }]) {
      const c = { ...good, done: true, pass };
      expect(parseCin7Cursor(JSON.stringify(c))).toEqual(c);
    }
    const bad: unknown[] = [
      "nope",
      "null",
      "[]",
      { ...good, done: "no" },
      { ...good, marks: null },
      { ...good, marks: undefined },
      { ...good, marks: { ...marks, sales: "yesterday" } },
      { ...good, marks: { products: null, customers: null, suppliers: null, sales: null } },
      { ...good, marks: { ...marks, products: "2026-01-01T00:00:00Z" } },
      { ...good, pass: undefined },
      { ...good, pass: { ...good.pass, list: "orders" } },
      { ...good, pass: { ...good.pass, list: "stock" } },
      { ...good, pass: { ...good.pass, list: "stock", since: before(1) } },
      { ...good, pass: { ...good.pass, since: "x" } },
      { ...good, pass: { ...good.pass, since: undefined } },
      { ...good, pass: { ...good.pass, page: 0 } },
      { ...good, pass: { ...good.pass, page: 1.5 } },
      { ...good, pass: { ...good.pass, page: CIN7_MAX_PAGE + 1 } },
      { ...good, pass: { ...good.pass, page: "2" } },
      { ...good, pass: { ...good.pass, began: null } },
      { ...good, pass: { ...good.pass, began: "2026-01-01T00:00:00" } },
    ];
    for (const raw of bad) expect(() => parseCin7Cursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Cin7 Core checkpoint is not in the expected shape");
  });
});

describe("Cin7 Core connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(cin7DocMock(account())), expected: { ingested: 12 } });
    expect(result.full.ingested).toBe(12);
  });

  it("imports every product, customer and supplier, five years of sales and purchases, then the stock, then stops for good", async () => {
    const data = account();
    data.products!.push(cin7Product.one({ Status: "Deprecated", LastModifiedOn: cin7Before(60_000) }));
    const mock = cin7DocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(13);
    const page = { Page: "1", Limit: "1000" };
    expect(mock.reads).toEqual([
      { list: "products", query: { ...page, IncludeDeprecated: "true" } },
      { list: "customers", query: { ...page, IncludeDeprecated: "true" } },
      { list: "suppliers", query: { ...page, IncludeDeprecated: "true" } },
      { list: "sales", query: { ...page, UpdatedSince: FIVE_YEARS } },
      { list: "purchases", query: { ...page, UpdatedSince: FIVE_YEARS } },
      { list: "stock", query: page },
    ]);
    const types = memory.events.map((e) => e.type);
    expect(types).toEqual([
      ...Array(3).fill("product.updated"),
      ...Array(2).fill("customer.profile_updated"),
      ...Array(2).fill("accounting.vendor_updated"),
      ...Array(2).fill("order.updated"),
      ...Array(2).fill("accounting.purchase_order_updated"),
      ...Array(2).fill("inventory.counted"),
    ]);
    expect(memory.events.slice(0, 3).map((e) => e.occurredAt)).toEqual([before(1), before(30), before(60_000)]);
    const began = { products: RECEIVED, customers: RECEIVED, suppliers: RECEIVED, sales: RECEIVED, purchases: RECEIVED };
    expect(parseCin7Cursor(report.cursor)).toEqual({ done: true, marks: began, pass: null });
    // Stock has no mark, and the checkpoint keeps none for it.
    expect(JSON.parse(report.cursor!)).toEqual({ done: true, marks: began, pass: null });
    assertSynthetic(memory.events);
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.reads).toHaveLength(6);
  });

  it("reads 1,000 a page, keeping the page in the checkpoint, and resumes there", async () => {
    cin7Product.reset();
    const products = Array.from({ length: 2300 }, (_, i) => cin7Product.one({ ID: cin7Guid("a", i + 1), SKU: `R-${i}`, LastModifiedOn: cin7Before(3000 - i) }));
    const data = account({ products, customers: [], suppliers: [], sales: [], purchases: [], stock: [] });
    const mock = cin7DocMock(data);
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([1000, 1000, 300, 0, 0, 0, 0, 0]);
    const cursors = batches.map((b) => parseCin7Cursor(b.cursor as string)!);
    expect(cursors.map((c) => c.pass?.list ?? null)).toEqual(["products", "products", "customers", "suppliers", "sales", "purchases", "stock", null]);
    expect(cursors[0]).toMatchObject({ done: false, marks: { products: null }, pass: { list: "products", since: null, page: 2, began: RECEIVED } });
    expect(cursors[2]).toMatchObject({ done: false, marks: { products: RECEIVED, customers: null }, pass: { list: "customers", since: null, page: 1 } });
    expect(cursors[3]!.pass).toMatchObject({ list: "suppliers", since: null });
    expect(cursors[4]!.pass).toMatchObject({ list: "sales", since: FIVE_YEARS });
    expect(cursors[6]!.pass).toMatchObject({ list: "stock", since: null });
    expect(cursors[7]).toMatchObject({ done: true, pass: null });
    const resumed = cin7DocMock(data);
    const rest = await drain(connector(resumed).historicalImport({ cursor: batches[0]!.cursor } as never));
    expect(resumed.reads.map((r) => [r.list, r.query.Page])).toEqual([["products", "2"], ["products", "3"], ["customers", "1"], ["suppliers", "1"], ["sales", "1"], ["purchases", "1"], ["stock", "1"]]);
    expect(rest.map((b) => b.events.length)).toEqual([1000, 300, 0, 0, 0, 0, 0]);
  });

  it("stops a list at a short page or the Total, and won't read past the most a pass reads", async () => {
    const asked: unknown[] = [];
    const full = Array.from({ length: CIN7_PAGE_SIZE }, () => ({}));
    let total = 2 * CIN7_PAGE_SIZE;
    let rows: unknown[] = full;
    const fake: Cin7Client = { page: async (list, _since, page) => (asked.push([list, page]), { rows, total }) };
    await drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual(ALL_LISTS.flatMap((list) => [[list, 1], [list, 2]]));
    asked.length = 0;
    total = 5 * CIN7_PAGE_SIZE;
    rows = full.slice(1);
    await drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual(ALL_LISTS.map((list) => [list, 1]));
    asked.length = 0;
    rows = full;
    total = CIN7_PAGE_SIZE;
    await drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: null } as never));
    expect(asked).toEqual(ALL_LISTS.map((list) => [list, 1]));
    asked.length = 0;
    total = (CIN7_MAX_PAGE + 5) * CIN7_PAGE_SIZE;
    const nearEnd = { done: false, marks: { products: null, customers: null, suppliers: null, sales: null, purchases: null }, pass: { list: "stock", since: null, page: CIN7_MAX_PAGE - 1, began: before(1) } };
    const run = drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify(nearEnd) } as never));
    await expect(run).rejects.toThrow(`Cin7 Core has more than ${CIN7_MAX_PAGE * CIN7_PAGE_SIZE} stock to read in one pass`);
    expect(asked).toEqual([["stock", CIN7_MAX_PAGE - 1], ["stock", CIN7_MAX_PAGE]]);
    asked.length = 0;
    total = CIN7_MAX_PAGE * CIN7_PAGE_SIZE;
    await drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ ...nearEnd, pass: { ...nearEnd.pass, page: CIN7_MAX_PAGE } }) } as never));
    expect(asked).toEqual([["stock", CIN7_MAX_PAGE]]);
  });

  it("reads each list from when its last pass began, less ten minutes, and the stock whole", async () => {
    const mock = cin7DocMock(account());
    const marks = { products: before(2), customers: before(40), suppliers: before(2), sales: before(2), purchases: before(31) };
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ done: true, marks, pass: null }) } as never));
    const less = (iso: string) => new Date(Date.parse(iso) - CIN7_OVERLAP_MS).toISOString();
    expect(mock.reads.map((r) => r.query.ModifiedSince ?? r.query.UpdatedSince ?? null)).toEqual([less(before(2)), less(before(40)), less(before(2)), less(before(2)), less(before(31)), null]);
    expect(eventsOf(batches).map((e) => e.type)).toEqual(["product.updated", "customer.profile_updated", "customer.profile_updated", "accounting.vendor_updated", "order.updated", "accounting.purchase_order_updated", "accounting.purchase_order_updated", "inventory.counted", "inventory.counted"]);
    expect(parseCin7Cursor(batches.at(-1)!.cursor as string)).toEqual({ done: true, marks: { products: RECEIVED, customers: RECEIVED, suppliers: RECEIVED, sales: RECEIVED, purchases: RECEIVED }, pass: null });
    expect(CIN7_OVERLAP_MS).toBe(600_000);
  });

  it("looks back three days on a first sync with no checkpoint, and doesn't call the import done", async () => {
    const mock = cin7DocMock(account());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(12);
    expect(mock.reads.map((r) => r.query.ModifiedSince ?? r.query.UpdatedSince ?? null)).toEqual([...Array(5).fill(before(72)), null]);
    expect(CIN7_FIRST_LOOKBACK_MS).toBe(72 * HOUR_MS);
    expect(batches.map((b) => parseCin7Cursor(b.cursor as string)!.done)).toEqual(Array(6).fill(false));
  });

  it("marks when each pass began, not the newest change it saw, so what changed while it read is read again", async () => {
    let clock = Date.parse("2026-11-11T15:00:00.000Z");
    const now = () => new Date(clock);
    const fake: Cin7Client = {
      page: async (list) => {
        clock += 5 * 60_000;
        return { rows: list === "products" ? [{ LastModifiedOn: "2030-01-01T00:00:00" }] : [], total: 0 };
      },
    };
    const batches = await drain(connector(cin7DocMock(account()), { client: fake, now }).incrementalSync({ cursor: null } as never));
    const cursor = parseCin7Cursor(batches.at(-1)!.cursor as string)!;
    const at = (minutes: number) => new Date(Date.parse("2026-11-11T15:00:00.000Z") + minutes * 60_000).toISOString();
    expect(cursor.marks).toEqual({ products: at(0), customers: at(5), suppliers: at(10), sales: at(15), purchases: at(20) });
    expect(parseCin7Cursor(batches[0]!.cursor as string)!.pass).toEqual({ list: "customers", since: new Date(Date.parse(at(5)) - CIN7_FIRST_LOOKBACK_MS).toISOString(), page: 1, began: at(5) });
  });

  it("keeps a finished import finished on every page, keeps marks of lists not read, and resumes a later sync part way", async () => {
    const asked: unknown[] = [];
    const fake: Cin7Client = { page: async (list, since, page) => (asked.push([list, since, page]), { rows: [], total: 0 }) };
    const marks = { products: before(1), customers: before(1), suppliers: before(1), sales: before(1), purchases: before(7) };
    const state = { done: true, marks, pass: { list: "stock", since: null, page: 3, began: before(2) } };
    const batches = await drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify(state) } as never));
    expect(asked).toEqual([["stock", null, 3]]);
    expect(parseCin7Cursor(batches[0]!.cursor as string)).toEqual({ done: true, marks, pass: null });
    const midSales = { done: true, marks, pass: { list: "sales", since: before(9), page: 2, began: before(3) } };
    const mid = await drain(connector(cin7DocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify(midSales) } as never));
    expect(parseCin7Cursor(mid.at(-1)!.cursor as string)!.marks).toEqual({ ...marks, sales: before(3), purchases: RECEIVED });
    expect(mid.map((b) => parseCin7Cursor(b.cursor as string)!.done)).toEqual([true, true, true]);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = account();
    data.products!.push({ ID: "x", LastModifiedOn: cin7Before(2) });
    data.stock!.push({ ID: cin7Guid("a", 7), Location: "Main", SKU: "R-1", OnHand: 0.5 });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(cin7DocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 12, deadLettered: 2 });
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = cin7DocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const batches = await drain(connector(mock, { sleep: async (ms) => void slept.push(ms), clock: () => 0 }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(12);
    expect(slept.filter((ms) => ms !== CIN7_SPACING_MS)).toEqual([5000, 10_000]);
  });

  it("stops on an id or key that's turned down", async () => {
    await expect(drain(connector(cin7DocMock(account({ applicationKey: cin7Guid("a", 99) }))).historicalImport({ cursor: null } as never))).rejects.toThrow("Cin7 Core turned down CIN7_ACCOUNT_ID and CIN7_APPLICATION_KEY");
    await expect(drain(connector(cin7DocMock(account({ accountId: cin7Guid("a", 99) }))).historicalImport({ cursor: null } as never))).rejects.toThrow(Cin7ConfigError);
  });

  it("checks its settings", () => {
    const mock = cin7DocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { applicationKey: "nope" })).toThrow(Cin7ConfigError);
    expect(() => connector(mock, { applicationKey: "nope", client: { page: async () => ({ rows: [], total: 0 }) } })).not.toThrow();
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const asked: unknown[] = [];
    const fake: Cin7Client = { page: async (list, since) => (asked.push(since), { rows: [], total: 0 }) };
    await drain(connector(cin7DocMock(account()), { client: fake, historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(asked).toEqual([null, null, null, "2025-11-11T15:00:00.000Z", "2025-11-11T15:00:00.000Z", null]);
    asked.length = 0;
    await drain(cin7Connector({ accountId: ACCOUNT, applicationKey: KEY, client: fake }).incrementalSync({ cursor: null } as never));
    expect(Math.abs(Date.parse(asked[0] as string) - (Date.now() - CIN7_FIRST_LOOKBACK_MS))).toBeLessThan(5000);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(CIN7_WRITES).toEqual([
      { integration: "cin7", name: "adjust_stock", description: "Adjust a product's stock at a location in Cin7 Core", kind: "update", approval: "each", dailyCap: 10 },
      { integration: "cin7", name: "create_purchase_order", description: "Create a draft purchase order for a supplier in Cin7 Core", kind: "append", approval: "each", dailyCap: 10 },
    ]);
    const c = connector(cin7DocMock(account()));
    expect(c.writes).toBe(CIN7_WRITES);
    expect(c.source).toBe("cin7");
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "adjust_stock", integration: "cin7", outcome: "refused" },
      { action: "create_purchase_order", integration: "cin7", outcome: "refused" },
    ]);
  });
});

describe("Cin7 Core doc mock", () => {
  const get = (mock: Cin7Mock, path: string, account = ACCOUNT, key = KEY) => mock.fetch(`${BASE}${path}`, { headers: { "api-auth-accountid": account, "api-auth-applicationkey": key } });
  type Body = Record<string, unknown> & { Total: number; Page: number };

  it("wants the id and key, and checks the parameters, page size and times", async () => {
    const mock = cin7DocMock(account());
    expect((await get(mock, "/product", ACCOUNT, "nope")).status).toBe(403);
    expect((await get(mock, "/product", "nope")).status).toBe(403);
    expect(await (await mock.fetch(`${BASE}/customer`)).json()).toEqual([{ ErrorCode: 403, Exception: "Method authentication failed" }]);
    for (const q of ["/product?since=1", "/product?Limit=1001", "/product?Limit=0", "/product?Page=0", "/product?Page=1.5", "/product?ModifiedSince=yesterday", "/saleList?ModifiedSince=2026-01-01", "/saleList?UpdatedSince=x", "/ref/productavailability?UpdatedSince=2026-01-01", "/supplier?Sku=1"]) {
      expect((await get(mock, q)).status, q).toBe(400);
    }
    const first = (await (await get(mock, "/product?Limit=1")).json()) as Body;
    expect(first).toMatchObject({ Total: 2, Page: 1 });
    expect((first.Products as unknown[]).length).toBe(1);
    const second = (await (await get(mock, "/product?Limit=1&Page=2")).json()) as Body;
    expect((second.Products as { ID: string }[])[0]!.ID).toBe(cin7Guid("a", 2));
    const recent = (await (await get(mock, `/customer?ModifiedSince=${encodeURIComponent(before(2))}`)).json()) as Body;
    expect(recent).toMatchObject({ Total: 1 });
    const noZ = (await (await get(mock, `/saleList?UpdatedSince=${cin7Before(31)}`)).json()) as Body;
    expect((noZ.SaleList as unknown[]).length).toBe(2);
    const purchases = (await (await get(mock, `/purchaseList?UpdatedSince=${encodeURIComponent(before(2))}`)).json()) as Body;
    expect(purchases).toMatchObject({ Total: 1 });
    const stock = (await (await get(mock, "/ref/productavailability")).json()) as Body;
    expect(stock).toMatchObject({ Total: 2 });
    expect((await (await get(cin7DocMock({ accountId: ACCOUNT, applicationKey: KEY }), "/supplier")).json()) as Body).toEqual({ Total: 0, Page: 1, SupplierList: [] });
    expect(mock.reads.at(-1)!.list).toBe("stock");
  });

  it("pages 100 at a time unless asked, and filters from the time given, read as UTC whatever the zone", async () => {
    cin7Product.reset();
    const mock = cin7DocMock(account({ products: Array.from({ length: 150 }, () => cin7Product.one()) }));
    expect(((await (await get(mock, "/product")).json()) as Body).Products).toHaveLength(100);
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const same = (await (await get(cin7DocMock(account()), `/customer?ModifiedSince=${cin7Before(30)}`)).json()) as Body;
      expect(same.Total).toBe(2);
      const z = (await (await get(cin7DocMock(account()), `/customer?ModifiedSince=${encodeURIComponent(before(30))}`)).json()) as Body;
      expect(z.Total).toBe(2);
      const later = (await (await get(cin7DocMock(account()), `/customer?ModifiedSince=${cin7Before(29.99)}`)).json()) as Body;
      expect(later.Total).toBe(1);
      const laterZ = (await (await get(cin7DocMock(account()), `/customer?ModifiedSince=${encodeURIComponent(before(29.99))}`)).json()) as Body;
      expect(laterZ.Total).toBe(1);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("leaves out deprecated records unless asked for them", async () => {
    const data = account();
    data.suppliers![0]!.Status = "Deprecated";
    const mock = cin7DocMock(data);
    expect(((await (await get(mock, "/supplier")).json()) as Body).Total).toBe(1);
    expect(((await (await get(mock, "/supplier?IncludeDeprecated=false")).json()) as Body).Total).toBe(1);
    expect(((await (await get(mock, "/supplier?IncludeDeprecated=true")).json()) as Body).Total).toBe(2);
    data.sales![0]!.Status = "Deprecated";
    expect(((await (await get(mock, "/saleList")).json()) as Body).Total).toBe(3);
  });

  it("answers 503 past 60 calls a minute", async () => {
    const mock = cin7DocMock(account({ rateLimits: 1 }));
    const r = await get(mock, "/product");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual([{ ErrorCode: 503, Exception: "You reached 60 calls per minute API limit" }]);
    expect((await get(mock, "/product")).status).toBe(200);
    expect(CIN7_DOC_PAGES.statusCodes).toMatch(/^https:\/\/help\.core\.cin7\.com\//);
    expect(cin7MockTime(1)).toBe("2026-01-01T00:01:00");
  });
});
