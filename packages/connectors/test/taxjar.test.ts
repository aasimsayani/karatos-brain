import { describe, expect, it, vi } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, taxjarDocMock, taxjarOrder, taxjarRefund, testPipeline, type TaxjarMock, type TaxjarMockData } from "@karatos/connector-testkit";
import {
  TAXJAR_API_VERSION,
  TAXJAR_BATCH,
  TAXJAR_HOSTS,
  TAXJAR_LOOKBACK_DAYS,
  TAXJAR_NEXUS_EVENT,
  TAXJAR_SPAN_DAYS,
  TAXJAR_TRANSACTION_EVENT,
  TAXJAR_WRITES,
  TaxjarApiError,
  TaxjarConfigError,
  parseTaxjarCursor,
  taxjarCents,
  taxjarClient,
  taxjarConnector,
  taxjarCustomerRef,
  taxjarDay,
  taxjarErrorDetail,
  taxjarId,
  taxjarNexusEvent,
  taxjarTransactionEvent,
  type TaxjarClient,
  type TaxjarCursor,
  type TaxjarEvent,
  type TaxjarOptions,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["tj", "test", "0".repeat(24)].join("");
const CUSTOMER_KEY = "c".repeat(40);
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const REGIONS = [
  { country_code: "US", country: "United States", region_code: "NY", region: "New York" },
  { country_code: "US", country: "United States", region_code: "CA", region: "California" },
];

/** Sales recorded on these days of 2026 (0 is Jan 1), and a refund of the 300th. */
function store(overrides: Partial<TaxjarMockData> = {}): TaxjarMockData {
  taxjarOrder.reset();
  taxjarRefund.reset();
  return {
    apiToken: TOKEN,
    orders: [10, 200, 300, 313].map((n) => taxjarOrder.one({ transaction_id: `T-${1000 + n}`, transaction_date: `${new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10)}T00:00:00Z` })),
    refunds: [taxjarRefund.one({ transaction_id: "T-1300-refund", transaction_reference_id: "T-1300", transaction_date: "2026-10-29T00:00:00Z" })],
    regions: REGIONS,
    ...overrides,
  };
}

const connector = (mock: TaxjarMock, overrides: Partial<TaxjarOptions> = {}) =>
  taxjarConnector({ apiToken: TOKEN, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });

/** The events of batches, as the connector made them. */
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as TaxjarEvent[];

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
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof taxjarClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = taxjarClient({ apiToken: TOKEN, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const Q = { from: "2026/10/01", to: "2026/10/31", provider: "api" };

describe("TaxJar client", () => {
  it("checks the token and environment before sending anything", () => {
    const { fetch, sent } = scripted(json(200, {}));
    expect(() => taxjarClient({ apiToken: "", fetch })).toThrow(TaxjarConfigError);
    expect(() => taxjarClient({ apiToken: "short", fetch })).toThrow("TAXJAR_API_TOKEN is missing or not in the expected shape");
    expect(() => taxjarClient({ apiToken: `${TOKEN}!`, fetch })).toThrow("TAXJAR_API_TOKEN");
    expect(() => taxjarClient({ apiToken: "a".repeat(129), fetch })).toThrow("TAXJAR_API_TOKEN");
    expect(() => taxjarClient({ apiToken: "a".repeat(128), fetch })).not.toThrow();
    expect(() => taxjarClient({ apiToken: "a".repeat(16), fetch })).not.toThrow();
    expect(() => taxjarClient({ apiToken: "a".repeat(15), fetch })).toThrow("TAXJAR_API_TOKEN");
    expect(() => taxjarClient({ apiToken: undefined as unknown as string, fetch })).toThrow("TAXJAR_API_TOKEN");
    expect(() => taxjarClient({ apiToken: TOKEN, environment: "live" as never, fetch })).toThrow("TAXJAR_ENVIRONMENT must be production or sandbox");
    expect(sent).toHaveLength(0);
  });

  it("lists ids with the token, version and filters, from production unless told", async () => {
    const { fetch, sent } = scripted(json(200, { orders: ["1", "2"] }));
    expect(await client(fetch, { apiToken: ` ${TOKEN} ` }).c.list("orders", Q)).toEqual(["1", "2"]);
    expect(sent).toEqual([
      {
        url: `${TAXJAR_HOSTS.production}/transactions/orders?from_transaction_date=2026%2F10%2F01&to_transaction_date=2026%2F10%2F31&provider=api`,
        method: "GET",
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", "x-api-version": TAXJAR_API_VERSION },
      },
    ]);
    expect(TAXJAR_API_VERSION).toBe("2022-01-24");
  });

  it("reads the sandbox when told", async () => {
    const { fetch, sent } = scripted(json(200, { refunds: [] }));
    await client(fetch, { environment: "sandbox" }).c.list("refunds", { ...Q, provider: "shopify" });
    expect(sent[0]!.url).toBe("https://api.sandbox.taxjar.com/v2/transactions/refunds?from_transaction_date=2026%2F10%2F01&to_transaction_date=2026%2F10%2F31&provider=shopify");
  });

  it("keeps only ids it would send back", async () => {
    const { fetch } = scripted(json(200, { orders: ["ok", "", " pad", "pad ", 7, null, "x".repeat(255), "x".repeat(256)] }));
    expect(await client(fetch).c.list("orders", Q)).toEqual(["ok", "x".repeat(255)]);
  });

  it("checks list filters before sending", async () => {
    const { fetch, sent } = scripted(json(200, { orders: [] }));
    const { c } = client(fetch);
    await expect(c.list("orders", { ...Q, from: "2026-10-01" })).rejects.toThrow("transactions must be listed between YYYY/MM/DD days");
    await expect(c.list("orders", { ...Q, to: "2026/10/1" })).rejects.toThrow(TaxjarApiError);
    await expect(c.list("orders", { ...Q, from: "x2026/10/01" })).rejects.toThrow(TaxjarApiError);
    await expect(c.list("orders", { ...Q, to: "2026/10/31x" })).rejects.toThrow(TaxjarApiError);
    await expect(c.list("orders", { ...Q, provider: "Shopify" })).rejects.toThrow("TAXJAR_PROVIDERS must be lowercase source names");
    await expect(c.list("orders", { ...Q, provider: "a&b=c" })).rejects.toThrow(TaxjarConfigError);
    expect(sent).toHaveLength(0);
  });

  it("says when a list answer has no list", async () => {
    const { fetch } = scripted(json(200, { refunds: [] }), json(200, { orders: "1,2" }), json(200, { orders: { 0: "1" } }));
    const { c } = client(fetch);
    for (let i = 0; i < 3; i++) await expect(c.list("orders", Q)).rejects.toThrow("TaxJar answered orders transactions without the orders list");
  });

  it("reads one transaction by its escaped id and provider", async () => {
    const order = { transaction_id: "A/1 #2" };
    const { fetch, sent } = scripted(json(200, { order }), json(200, { refund: { transaction_id: "r" } }));
    const { c } = client(fetch);
    expect(await c.show("orders", "A/1 #2", "api")).toEqual(order);
    expect(sent[0]!.url).toBe(`${TAXJAR_HOSTS.production}/transactions/orders/A%2F1%20%232?provider=api`);
    expect(await c.show("refunds", "r", "amazon")).toEqual({ transaction_id: "r" });
    expect(sent[1]!.url).toBe(`${TAXJAR_HOSTS.production}/transactions/refunds/r?provider=amazon`);
  });

  it("answers null for a transaction TaxJar no longer has", async () => {
    const { fetch } = scripted(json(404, { error: "Not Found", detail: "Resource can't be found", status: 404 }));
    expect(await client(fetch).c.show("orders", "gone", "api")).toBeNull();
  });

  it("won't put an id or provider it can't vouch for in a path", async () => {
    const { fetch, sent } = scripted(json(200, { order: {} }));
    const { c } = client(fetch);
    await expect(c.show("orders", "", "api")).rejects.toThrow("a transaction id must be 1 to 255 characters");
    await expect(c.show("orders", " a", "api")).rejects.toThrow(TaxjarApiError);
    await expect(c.show("orders", "a", "API")).rejects.toThrow(TaxjarConfigError);
    expect(sent).toHaveLength(0);
  });

  it("says when a transaction answer has no transaction", async () => {
    const { fetch } = scripted(json(200, { refund: {} }), json(200, { order: [] }), json(200, { order: {} }));
    const { c } = client(fetch);
    await expect(c.show("orders", "a", "api")).rejects.toThrow("TaxJar answered a order transaction without it");
    await expect(c.show("orders", "a", "api")).rejects.toThrow(TaxjarApiError);
    await expect(c.show("refunds", "a", "api")).rejects.toThrow("TaxJar answered a refund transaction without it");
  });

  it("reads the nexus regions", async () => {
    const { fetch, sent } = scripted(json(200, { regions: REGIONS }), json(200, { regions: {} }));
    const { c } = client(fetch);
    expect(await c.nexusRegions()).toEqual(REGIONS);
    expect(sent[0]!.url).toBe(`${TAXJAR_HOSTS.production}/nexus/regions`);
    await expect(c.nexusRegions()).rejects.toThrow("TaxJar answered nexus regions without the regions list");
  });

  it("explains a turned-down token, a forbidden read and other errors, with TaxJar's detail", async () => {
    const detail = (status: number, d: unknown) => json(status, { error: "x", detail: d, status });
    const { fetch } = scripted(detail(401, "Not authorized"), detail(403, "Plan has no API"), detail(422, "Bad date"), text(500, "oops"), detail(404, "Not here"), detail(400, 7), json(202, { regions: [] }));
    const { c } = client(fetch, { retries: 0 });
    await expect(c.list("orders", Q)).rejects.toMatchObject({ status: 401, detail: "Not authorized", message: "TaxJar turned down the API token: check TAXJAR_API_TOKEN, and that TAXJAR_ENVIRONMENT matches where it was made" });
    await expect(c.list("orders", Q)).rejects.toMatchObject({ status: 403, message: "TaxJar's account isn't allowed to read orders transactions (Plan has no API)" });
    await expect(c.list("orders", Q)).rejects.toMatchObject({ status: 422, message: "TaxJar answered HTTP 422 for orders transactions (Bad date)" });
    await expect(c.nexusRegions()).rejects.toMatchObject({ status: 500, detail: undefined, message: "TaxJar answered HTTP 500 for nexus regions" });
    // A 404 is only a missing transaction when one was asked for.
    await expect(c.list("refunds", Q)).rejects.toMatchObject({ status: 404, message: "TaxJar answered HTTP 404 for refunds transactions (Not here)" });
    await expect(c.list("refunds", Q)).rejects.toMatchObject({ status: 400, detail: undefined });
    await expect(c.nexusRegions()).rejects.toMatchObject({ status: 202, message: "TaxJar answered HTTP 202 for nexus regions" });
  });

  it("says when a 200 isn't a JSON object", async () => {
    const { fetch } = scripted(text(200, "<html>"), json(200, ["a"]), json(200, null));
    const { c } = client(fetch);
    for (let i = 0; i < 3; i++) await expect(c.nexusRegions()).rejects.toMatchObject({ status: 200, message: "TaxJar answered nexus regions with a body that isn't a JSON object" });
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "5" }), json(500, {}), json(502, {}, { "retry-after": "600" }), json(200, { regions: [] }));
    const { c, slept } = client(fetch);
    expect(await c.nexusRegions()).toEqual([]);
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([5000, 2000, 60_000]);
  });

  it("retries 503 and 504 too, backing off when Retry-After doesn't read, then gives up", async () => {
    const { fetch, sent } = scripted(json(503, {}, { "retry-after": "soon" }), json(504, {}, { "retry-after": "0" }), json(503, {}, { "retry-after": "-3" }), json(503, { detail: "Down" }));
    const { c, slept } = client(fetch);
    await expect(c.nexusRegions()).rejects.toMatchObject({ status: 503, message: "TaxJar answered HTTP 503 for nexus regions (Down)" });
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const { fetch, sent } = scripted(json(400, {}));
    await expect(client(fetch).c.nexusRegions()).rejects.toMatchObject({ status: 400 });
    expect(sent).toHaveLength(1);
    const again = scripted(json(429, {}));
    await expect(client(again.fetch, { retries: 1 }).c.nexusRegions()).rejects.toMatchObject({ status: 429 });
    expect(again.sent).toHaveLength(2);
  });

  it("waits for real when no sleep is given", async () => {
    const { fetch } = scripted(json(429, {}, { "retry-after": "0.001" }), json(200, { regions: [] }));
    expect(await taxjarClient({ apiToken: TOKEN, fetch }).nexusRegions()).toEqual([]);
  });

  it("uses the global fetch when none is given", async () => {
    const { fetch, sent } = scripted(json(200, { regions: [] }));
    vi.stubGlobal("fetch", fetch);
    try {
      expect(await taxjarClient({ apiToken: TOKEN }).nexusRegions()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
  });

  it("only ever sends GETs", async () => {
    const mock = taxjarDocMock(store());
    await runSync({ connector: connector(mock), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(mock.fetch.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });
});

describe("TaxJar reading helpers", () => {
  it("reads amounts as whole cents, from numbers or numeric strings", () => {
    expect(taxjarCents(17)).toBe(1700);
    expect(taxjarCents(0.95)).toBe(95);
    expect(taxjarCents("0.95")).toBe(95);
    expect(taxjarCents("-15.5")).toBe(-1550);
    expect(taxjarCents(1.005)).toBe(101);
    expect(taxjarCents(-0.95)).toBe(-95);
    expect(taxjarCents("1.123456")).toBe(112);
    for (const bad of ["1.1234567", "1e3", " 1", "", "abc", null, undefined, NaN, Infinity, 1e13, -1e13, "12345678901234"]) expect(taxjarCents(bad), String(bad)).toBeNull();
    expect(taxjarCents(9_999_999_999_999)).toBe(999_999_999_999_900);
    expect(taxjarCents("9999999999999.5")).toBe(999_999_999_999_950);
    expect(taxjarCents("10000000000000")).toBeNull();
  });

  it("reads days from TaxJar's times or bare days", () => {
    expect(taxjarDay("2015-05-14T00:00:00Z")).toBe("2015-05-14");
    expect(taxjarDay("2015-05-14T00:00:00.000Z")).toBe("2015-05-14");
    expect(taxjarDay("2015-05-14T08:30:00-07:00")).toBe("2015-05-14");
    expect(taxjarDay("2015-05-14T08:30:00")).toBe("2015-05-14");
    expect(taxjarDay("2015-05-14")).toBe("2015-05-14");
    expect(taxjarDay("2015/05/14")).toBe("2015-05-14");
    expect(taxjarDay("1970-01-01")).toBe("1970-01-01");
    for (const bad of ["2015-02-30", "2015-13-01", "1969-12-31", "15-05-14", "2015-05-14T", "2015-05-14 00:00:00", "x2015-05-14", "2015-05-14x", 20150514, null]) expect(taxjarDay(bad), String(bad)).toBeNull();
  });

  it("turns a customer id into a keyed reference", () => {
    const a = taxjarCustomerRef(CUSTOMER_KEY, "cust-1");
    expect(a).toMatch(/^taxjar_customer:[0-9a-f]{32}$/);
    expect(taxjarCustomerRef(CUSTOMER_KEY, " cust-1 ")).toBe(a);
    expect(taxjarCustomerRef("d".repeat(40), "cust-1")).not.toBe(a);
    expect(taxjarCustomerRef(CUSTOMER_KEY, "cust-2")).not.toBe(a);
    expect(taxjarCustomerRef(CUSTOMER_KEY, "x".repeat(255))).toBeDefined();
    for (const bad of ["", "  ", "x".repeat(256), 5, null]) expect(taxjarCustomerRef(CUSTOMER_KEY, bad)).toBeUndefined();
  });

  it("reads TaxJar's error detail only when it is short plain text", () => {
    expect(taxjarErrorDetail({ detail: "Not authorized for route 'GET /v2/nexus/regions'" })).toBe("Not authorized for route 'GET /v2/nexus/regions'");
    for (const bad of [{ detail: "x".repeat(201) }, { detail: "<script>" }, { detail: "" }, { detail: 3 }, ["detail"], null, "detail"]) expect(taxjarErrorDetail(bad)).toBeUndefined();
    expect(taxjarErrorDetail({ detail: "x".repeat(200) })).toBe("x".repeat(200));
  });

  it("vouches only for ids it can send back", () => {
    expect(taxjarId("a")).toBe(true);
    for (const bad of ["", " a", "a ", "x".repeat(256), 1, null]) expect(taxjarId(bad)).toBe(false);
  });
});

describe("TaxJar events", () => {
  const ctx = { customerKey: CUSTOMER_KEY, provider: "api", receivedAt: RECEIVED };
  const order = () => {
    taxjarOrder.reset();
    return taxjarOrder.one({ transaction_id: "T-1", transaction_date: "2026-10-28T00:00:00Z", customer_id: "cust-9", exemption_type: null });
  };

  it("keeps the money, the places taxed and the lines, and drops the customer", () => {
    const { ok, event } = taxjarTransactionEvent(order(), "orders", ctx);
    expect(ok).toBe(true);
    expect(event.type).toBe(TAXJAR_TRANSACTION_EVENT);
    expect(event.type).toBe("tax.transaction_updated");
    expect(event.occurredAt).toBe("2026-10-28T00:00:00.000Z");
    expect(event.receivedAt).toBe(RECEIVED);
    expect(event.payload).toEqual({
      system: "TaxJar",
      transactionId: "T-1",
      kind: "sale",
      provider: "api",
      referenceId: undefined,
      day: "2026-10-28",
      amountCents: 120_100,
      shippingCents: 1500,
      salesTaxCents: 9525,
      exemptReason: undefined,
      fromCountry: "US",
      fromRegion: "NY",
      fromCity: "NEW YORK",
      fromZip: "10036",
      toCountry: "US",
      toRegion: "CA",
      customerRef: taxjarCustomerRef(CUSTOMER_KEY, "cust-9"),
      lineCount: 1,
      lines: [{ id: "1", sku: "RING-1", taxCode: undefined, quantity: 1, unitPriceCents: 118_600, discountCents: 0, salesTaxCents: 9525 }],
    });
    const text = JSON.stringify(event);
    for (const gone of ["Test Lane", "90002", "LOS ANGELES", "Test ring", "Test Customer", "cust-9", "1 Test Plaza", "11836"]) expect(text, gone).not.toContain(gone);
    expect(event.idempotencyKey).toMatch(/^taxjar:orders:api:T-1:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
  });

  it("reads a refund as a return of the order it names, with its exemption", () => {
    taxjarRefund.reset();
    const { ok, event } = taxjarTransactionEvent(taxjarRefund.one({ exemption_type: "wholesale", provider: "shopify" }), "refunds", { ...ctx, provider: "shopify" });
    expect(ok).toBe(true);
    expect(event.payload).toMatchObject({ kind: "return", provider: "shopify", referenceId: "T-1001", amountCents: -120_100, shippingCents: -1500, salesTaxCents: -9525, exemptReason: "wholesale" });
    expect(event.idempotencyKey).toMatch(/^taxjar:refunds:shopify:T-1001-refund:/);
  });

  it("keeps documented exemptions but not non_exempt or unknown ones", () => {
    for (const [given, kept] of [["government", "government"], ["marketplace", "marketplace"], ["other", "other"], ["non_exempt", undefined], ["charity", undefined], [5, undefined]] as const) {
      expect(taxjarTransactionEvent({ ...order(), exemption_type: given }, "orders", ctx).event.payload.exemptReason, String(given)).toBe(kept);
    }
  });

  it("falls back to the provider it was listed under, and checks the one TaxJar names", () => {
    expect(taxjarTransactionEvent({ ...order(), provider: "amazon" }, "orders", { ...ctx, provider: "api" }).event.payload.provider).toBe("amazon");
    for (const given of [undefined, "Shop ify", 3]) expect(taxjarTransactionEvent({ ...order(), provider: given }, "orders", { ...ctx, provider: "ebay" }).event.payload.provider).toBe("ebay");
  });

  it("drops fields that don't read, and caps the lines kept", () => {
    const raw = {
      ...order(),
      transaction_reference_id: "x".repeat(256),
      shipping: "free",
      from_country: "USA",
      from_state: "New York",
      from_city: "<b>",
      from_zip: "1",
      to_country: "us",
      to_state: "ca",
      line_items: [...Array.from({ length: 250 }, (_, i) => ({ id: String(i), quantity: 1, unit_price: 1 })), "not a line"],
    };
    const { ok, event } = taxjarTransactionEvent(raw, "orders", ctx);
    expect(ok).toBe(true);
    expect(event.payload).toMatchObject({ referenceId: undefined, shippingCents: null, fromCountry: undefined, fromRegion: undefined, fromCity: undefined, fromZip: undefined, toCountry: undefined, toRegion: undefined, lineCount: 251 });
    expect(event.payload.lines).toHaveLength(200);
    const odd = taxjarTransactionEvent({ ...order(), line_items: [null, { id: "a b!", product_identifier: "<x>", product_tax_code: "20010", quantity: "2", unit_price: "3", discount: null, sales_tax: Infinity }] }, "orders", ctx);
    expect(taxjarTransactionEvent({ ...order(), line_items: [{ quantity: Infinity }, { quantity: 2.5 }] }, "orders", ctx).event.payload.lines).toMatchObject([{ quantity: null }, { quantity: 2.5 }]);
    expect(odd.event.payload.lines).toEqual([{ id: undefined, sku: undefined, taxCode: "20010", quantity: null, unitPriceCents: 300, discountCents: null, salesTaxCents: null }]);
    expect(taxjarTransactionEvent({ ...order(), line_items: "none" }, "orders", ctx).event.payload).toMatchObject({ lineCount: 0, lines: [] });
  });

  it("is a duplicate when read again unchanged, and a new event when changed", () => {
    const a = taxjarTransactionEvent(order(), "orders", ctx).event;
    expect(taxjarTransactionEvent(order(), "orders", { ...ctx, receivedAt: "2027-01-01T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(taxjarTransactionEvent({ ...order(), sales_tax: 1 }, "orders", ctx).event.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("makes ids safe whatever the transaction id holds", () => {
    const { event } = taxjarTransactionEvent({ ...order(), transaction_id: "A/1 #2" }, "orders", ctx);
    expect(event.id).toMatch(/^taxjar_orders_api_A_1__2_[0-9a-f]{12}$/);
    expect(event.payload.transactionId).toBe("A/1 #2");
  });

  it("dead-letters a transaction it can't read, saying why", () => {
    const { ok, event } = taxjarTransactionEvent({ transaction_id: "", transaction_date: "soon", amount: "lots", sales_tax: null }, "orders", ctx);
    expect(ok).toBe(false);
    expect(event.occurredAt).toBeUndefined();
    expect(event.payload).toEqual({ system: "TaxJar", transactionId: null, problems: ["transaction has no id that reads", "transaction has no day that reads", "transaction has no amount that reads", "transaction has no sales tax that reads"] });
    expect(event.idempotencyKey).toMatch(/^taxjar:unreadable_transaction:[0-9a-f]{12}$/);
    const notObject = taxjarTransactionEvent(["x"], "refunds", ctx);
    expect(notObject.event.payload.problems).toContain("transaction is not an object");
    const long = taxjarTransactionEvent({ ...order(), transaction_id: "x".repeat(256) }, "orders", ctx);
    expect(long.event.payload).toMatchObject({ transactionId: null, problems: ["transaction has no id that reads"] });
    expect(taxjarTransactionEvent({ ...order(), transaction_id: "x".repeat(255) }, "orders", ctx).ok).toBe(true);
    // Keeps the id it could read.
    expect(taxjarTransactionEvent({ ...order(), amount: null }, "orders", ctx).event.payload).toMatchObject({ transactionId: "T-1" });
  });

  it("lists the nexus regions in a fixed order, as one event", () => {
    const event = taxjarNexusEvent([...REGIONS, { country_code: "GB", country: "United Kingdom", region_code: null, region: null }, { country_code: "usa" }, "x", { country_code: "US", region_code: "<>", region: "x".repeat(61) }], RECEIVED);
    expect(event.type).toBe(TAXJAR_NEXUS_EVENT);
    expect(event.type).toBe("tax.nexus_updated");
    expect(event.occurredAt).toBe(RECEIVED);
    expect(event.payload).toEqual({
      system: "TaxJar",
      regions: [
        { country: "GB", region: undefined, name: undefined },
        { country: "US", region: undefined, name: undefined },
        { country: "US", region: "CA", name: "California" },
        { country: "US", region: "NY", name: "New York" },
      ],
    });
    expect(event.idempotencyKey).toMatch(/^taxjar:nexus:[0-9a-f]{12}$/);
    expect(event.id).toBe(event.idempotencyKey.replace(/:/g, "_"));
    expect(taxjarNexusEvent([...REGIONS].reverse(), "2027-01-01T00:00:00.000Z").idempotencyKey).toBe(taxjarNexusEvent(REGIONS, RECEIVED).idempotencyKey);
    expect(taxjarNexusEvent(REGIONS.slice(1), RECEIVED).idempotencyKey).not.toBe(taxjarNexusEvent(REGIONS, RECEIVED).idempotencyKey);
    const many = Array.from({ length: 320 }, (_, i) => ({ country_code: "US", region_code: String(i) }));
    expect((taxjarNexusEvent(many, RECEIVED).payload.regions as unknown[]).length).toBe(300);
  });
});

describe("TaxJar checkpoint", () => {
  const pass = { from: "2021-11-10", until: "2026-11-10", step: 1, spanFrom: "2022-01-01", offset: 100 };

  it("round-trips and turns down any other shape", () => {
    expect(parseTaxjarCursor(null)).toBeNull();
    const c: TaxjarCursor = { pass, done: false };
    expect(parseTaxjarCursor(JSON.stringify(c))).toEqual(c);
    expect(parseTaxjarCursor(JSON.stringify({ pass: null, done: true }))).toEqual({ pass: null, done: true });
    expect(parseTaxjarCursor(JSON.stringify({ pass: null, done: false }))).toEqual({ pass: null, done: false });
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ pass: null }),
      JSON.stringify({ pass: null, done: "yes" }),
      JSON.stringify({ pass: [], done: false }),
      JSON.stringify({ pass: "x", done: false }),
      JSON.stringify({ pass: { ...pass, from: "2021-02-30" }, done: false }),
      JSON.stringify({ pass: { ...pass, until: "2026/11/10" }, done: false }),
      JSON.stringify({ pass: { ...pass, step: -1 }, done: false }),
      JSON.stringify({ pass: { ...pass, step: 1.5 }, done: false }),
      JSON.stringify({ pass: { ...pass, spanFrom: null }, done: false }),
      JSON.stringify({ pass: { ...pass, offset: "1" }, done: false }),
      JSON.stringify({ pass, done: null }),
    ]) {
      expect(() => parseTaxjarCursor(bad), bad).toThrow("TaxJar checkpoint is not in the expected shape");
    }
  });

  it("turns down a step past the last", async () => {
    const mock = taxjarDocMock(store());
    const cursor = JSON.stringify({ pass: { ...pass, step: 3 }, done: false });
    await expect(drain(connector(mock).historicalImport({ cursor } as never))).rejects.toThrow("TaxJar checkpoint is not in the expected shape");
    // Step 2 is the nexus read, for one provider.
    const last = await drain(connector(mock).historicalImport({ cursor: JSON.stringify({ pass: { ...pass, step: 2 }, done: false }) } as never));
    expect(last).toHaveLength(1);
    expect(eventsOf(last).map((e) => e.type)).toEqual([TAXJAR_NEXUS_EVENT]);
  });
});

describe("TaxJar connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(taxjarDocMock(store())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports five years of sales and refunds by 31-day spans, then the nexus regions, then stops for good", async () => {
    const mock = taxjarDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    const orders = mock.lists.filter((l) => l.kind === "orders");
    expect(orders[0]).toEqual({ kind: "orders", from: "2021/11/10", to: "2021/12/10", provider: "api" });
    expect(orders[1]).toEqual({ kind: "orders", from: "2021/12/11", to: "2022/01/10", provider: "api" });
    expect(orders.at(-1)!.to).toBe("2026/11/10");
    // Spans join without a gap or an overlap.
    for (let i = 1; i < orders.length; i++) expect(Date.parse(orders[i]!.from.replace(/\//g, "-")) - Date.parse(orders[i - 1]!.to.replace(/\//g, "-"))).toBe(DAY_MS);
    expect(mock.lists.filter((l) => l.kind === "refunds")).toHaveLength(orders.length);
    expect(mock.lists.findIndex((l) => l.kind === "refunds")).toBe(orders.length);
    expect(mock.shows.map((s) => s.id)).toEqual(["T-1010", "T-1200", "T-1300", "T-1313", "T-1300-refund"]);
    expect(memory.events.map((e) => e.type).sort()).toEqual([...Array(5).fill(TAXJAR_TRANSACTION_EVENT), TAXJAR_NEXUS_EVENT].sort());
    assertSynthetic(memory.events);
    const calls = mock.fetch.calls.length;
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested).toBe(0);
    expect(mock.fetch.calls).toHaveLength(calls);
  });

  it("skips what was recorded before the history window", async () => {
    const mock = taxjarDocMock(store({ orders: [taxjarOrder.one({ transaction_date: "2021-11-09T00:00:00Z" }), taxjarOrder.one({ transaction_date: "2021-11-10T00:00:00Z" })], refunds: [] }));
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches).filter((e) => e.type === TAXJAR_TRANSACTION_EVENT).map((e) => e.payload.day)).toEqual(["2021-11-10"]);
    const short = taxjarDocMock(store());
    await drain(connector(short, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(short.lists[0]!.from).toBe("2025/11/10");
  });

  it("checks its settings", () => {
    const mock = taxjarDocMock(store());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    expect(() => connector(mock, { providers: ["api", "Shopify"] })).toThrow("TAXJAR_PROVIDERS must be lowercase source names such as api or shopify");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiToken: "x" })).toThrow("TAXJAR_API_TOKEN");
    expect(() => connector(mock, { apiToken: "x", client: {} as TaxjarClient })).not.toThrow();
    expect(connector(mock).source).toBe("taxjar");
  });

  it("reads each provider named, orders then refunds, once each", async () => {
    const data = store();
    data.orders.push(taxjarOrder.one({ transaction_id: "S-1", provider: "shopify", transaction_date: "2026-11-01T00:00:00Z" }));
    const mock = taxjarDocMock(data);
    const batches = await drain(connector(mock, { providers: ["api", "shopify", "api"] }).incrementalSync({ cursor: null } as never));
    const order = mock.lists.map((l) => `${l.provider}:${l.kind}`).filter((v, i, a) => a.indexOf(v) === i);
    expect(order).toEqual(["api:orders", "api:refunds", "shopify:orders", "shopify:refunds"]);
    // A provider named twice is read once.
    expect(mock.lists).toHaveLength(4);
    expect(mock.shows.filter((s) => s.provider === "shopify").map((s) => s.id)).toEqual(["S-1"]);
    expect(eventsOf(batches).find((e) => e.payload.transactionId === "S-1")!.payload.provider).toBe("shopify");
  });

  it("reads 100 at a time, keeping the span and offset in the checkpoint, and resumes there", async () => {
    taxjarOrder.reset();
    const orders = Array.from({ length: 250 }, (_, i) => taxjarOrder.one({ transaction_id: `T-${String(i).padStart(3, "0")}`, transaction_date: "2026-11-01T00:00:00Z" }));
    const mock = taxjarDocMock(store({ orders, refunds: [] }));
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 50, 1]);
    const cursors = batches.map((b) => parseTaxjarCursor(b.cursor ?? null));
    const pass = { from: "2026-10-11", until: "2026-11-10" };
    expect(cursors).toEqual([
      { pass: { ...pass, step: 0, spanFrom: "2026-10-11", offset: 100 }, done: false },
      { pass: { ...pass, step: 0, spanFrom: "2026-10-11", offset: 200 }, done: false },
      { pass: { ...pass, step: 1, spanFrom: "2026-10-11", offset: 0 }, done: false },
      { pass: null, done: false },
    ]);
    expect(TAXJAR_BATCH).toBe(100);
    // Resumed after the first batch, it reads the rest in order.
    const resumed = taxjarDocMock(store({ orders, refunds: [] }));
    const rest = await drain(connector(resumed).incrementalSync({ cursor: batches[0]!.cursor } as never));
    expect(rest.map((b) => b.events.length)).toEqual([100, 50, 1]);
    expect(resumed.shows[0]!.id).toBe("T-100");
    expect(resumed.shows).toHaveLength(150);
  });

  it("moves to the next span when one ends on a full batch", async () => {
    taxjarOrder.reset();
    const orders = [...Array.from({ length: 100 }, (_, i) => taxjarOrder.one({ transaction_id: `A-${String(i).padStart(3, "0")}`, transaction_date: "2026-01-05T00:00:00Z" })), taxjarOrder.one({ transaction_id: "B-1", transaction_date: "2026-02-05T00:00:00Z" })];
    const mock = taxjarDocMock(store({ orders, refunds: [] }));
    const cursor = JSON.stringify({ pass: { from: "2026-01-01", until: "2026-03-01", step: 0, spanFrom: "2026-01-01", offset: 0 }, done: false });
    const batches = await drain(connector(mock).historicalImport({ cursor } as never));
    expect(batches.map((b) => parseTaxjarCursor(b.cursor ?? null))).toEqual([
      { pass: { from: "2026-01-01", until: "2026-03-01", step: 0, spanFrom: "2026-02-01", offset: 0 }, done: false },
      { pass: { from: "2026-01-01", until: "2026-03-01", step: 1, spanFrom: "2026-01-01", offset: 0 }, done: false },
      { pass: null, done: true },
    ]);
    expect(mock.lists.map((l) => `${l.kind} ${l.from}-${l.to}`)).toEqual([
      "orders 2026/01/01-2026/01/31",
      "orders 2026/02/01-2026/03/01",
      "refunds 2026/01/01-2026/01/31",
      "refunds 2026/02/01-2026/03/01",
    ]);
    expect(TAXJAR_SPAN_DAYS).toBe(31);
  });

  it("reads a last span of a single day", async () => {
    const mock = taxjarDocMock(store({ orders: [taxjarOrder.one({ transaction_id: "LAST", transaction_date: "2026-02-01T00:00:00Z" })], refunds: [] }));
    const cursor = JSON.stringify({ pass: { from: "2026-01-01", until: "2026-02-01", step: 0, spanFrom: "2026-01-01", offset: 0 }, done: false });
    const batches = await drain(connector(mock).historicalImport({ cursor } as never));
    expect(mock.lists.filter((l) => l.kind === "orders").map((l) => `${l.from}-${l.to}`)).toEqual(["2026/01/01-2026/01/31", "2026/02/01-2026/02/01"]);
    expect(eventsOf(batches).map((e) => e.payload.transactionId)).toContain("LAST");
  });

  it("names the provider it listed under when TaxJar's record doesn't", async () => {
    const client: TaxjarClient = {
      list: async (kind) => (kind === "orders" ? ["X-1"] : []),
      show: async () => ({ ...taxjarOrder.one({ transaction_id: "X-1", transaction_date: "2026-11-01T00:00:00Z" }), provider: undefined }),
      nexusRegions: async () => [],
    };
    const batches = await drain(taxjarConnector({ apiToken: TOKEN, customerKey: CUSTOMER_KEY, now: NOW, client, providers: ["ebay"] }).incrementalSync({ cursor: null } as never));
    expect(eventsOf(batches)[0]!.payload.provider).toBe("ebay");
  });

  it("reads each listed id once, in order, and skips one deleted since it was listed", async () => {
    const data = store({ vanished: ["T-1300"] });
    const listed = taxjarDocMock(data);
    const client: TaxjarClient = {
      list: async (kind, q) => (kind === "orders" && q.from === "2026-10-11".replace(/-/g, "/") ? ["T-1313", "T-1300", "T-1313"] : []),
      show: (kind, id, provider) => taxjarClient({ apiToken: TOKEN, fetch: listed.fetch }).show(kind, id, provider),
      nexusRegions: async () => [],
    };
    const batches = await drain(taxjarConnector({ apiToken: TOKEN, customerKey: CUSTOMER_KEY, now: NOW, client }).incrementalSync({ cursor: null } as never));
    expect(listed.shows.map((s) => s.id)).toEqual(["T-1300", "T-1313"]);
    expect(eventsOf(batches.slice(0, 1)).map((e) => e.payload.transactionId)).toEqual(["T-1313"]);
  });

  it("reads up to today when no clock is given", async () => {
    const lists: string[] = [];
    const client: TaxjarClient = { list: async (_k, q) => (lists.push(q.to), []), show: async () => null, nexusRegions: async () => [] };
    await drain(taxjarConnector({ apiToken: TOKEN, customerKey: CUSTOMER_KEY, client }).incrementalSync({ cursor: null } as never));
    expect(lists.at(-1)).toBe(new Date().toISOString().slice(0, 10).replace(/-/g, "/"));
  });

  it("dead-letters a transaction it can't read and carries on", async () => {
    const mock = taxjarDocMock(store({ orders: [taxjarOrder.one({ transaction_id: "bad", transaction_date: "2026-11-01T00:00:00Z", amount: "lots" }), taxjarOrder.one({ transaction_date: "2026-11-02T00:00:00Z" })], refunds: [] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(2);
    expect(report.deadLettered).toBe(1);
  });

  it("syncs the last 31 days each time, so a late or changed transaction is read, and an unchanged one is a duplicate", async () => {
    const data = store();
    const mock = taxjarDocMock(data);
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.lists[0]).toEqual({ kind: "orders", from: "2026/10/11", to: "2026/11/10", provider: "api" });
    expect(TAXJAR_LOOKBACK_DAYS).toBe(31);
    // T-1300 (Oct 28), T-1313 (Nov 10), the refund (Oct 29) and the nexus regions.
    expect(first.ingested).toBe(4);
    data.orders.push(taxjarOrder.one({ transaction_id: "LATE", transaction_date: "2026-10-15T00:00:00Z" }));
    data.orders[2]!.sales_tax = 1;
    const second = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(second.ingested).toBe(2);
    expect(second.duplicates).toBe(3);
    const later = () => new Date(NOW().getTime() + 10 * DAY_MS);
    await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.lists.at(-2)).toEqual({ kind: "orders", from: "2026/10/21", to: "2026/11/20", provider: "api" });
  });

  it("resumes a pass part way from its own span, not a new one", async () => {
    const mock = taxjarDocMock(store());
    const cursor = JSON.stringify({ pass: { from: "2026-09-01", until: "2026-10-31", step: 1, spanFrom: "2026-10-01", offset: 0 }, done: false });
    await drain(connector(mock).incrementalSync({ cursor } as never));
    expect(mock.lists.map((l) => `${l.kind} ${l.from}-${l.to}`)).toEqual(["refunds 2026/10/01-2026/10/31"]);
    // A finished import doesn't stop later syncs.
    const after = taxjarDocMock(store());
    await drain(connector(after).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true }) } as never));
    expect(after.lists[0]!.from).toBe("2026/10/11");
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = taxjarDocMock(store({ rateLimits: 2 }));
    const slept: number[] = [];
    await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([1000, 2000]);
  });

  it("stops on a turned-down token, keeping the checkpoint", async () => {
    const mock = taxjarDocMock(store({ apiToken: "z".repeat(32) }));
    await expect(drain(connector(mock).incrementalSync({ cursor: null } as never))).rejects.toMatchObject({ status: 401 });
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(TAXJAR_WRITES.map((w) => w.name)).toEqual(["create_order_transaction", "create_refund_transaction"]);
    expect(TAXJAR_WRITES.every((w) => w.integration === "taxjar")).toBe(true);
    const c = connector(taxjarDocMock(store()));
    expect(c.writes).toBe(TAXJAR_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "create_order_transaction", integration: "taxjar", outcome: "refused" },
      { action: "create_refund_transaction", integration: "taxjar", outcome: "refused" },
    ]);
  });
});

describe("TaxJar doc mock", () => {
  it("turns down a wrong token and bad dates, and filters by provider and days", async () => {
    const mock = taxjarDocMock(store());
    const get = (path: string, token = TOKEN) => mock.fetch(`https://api.taxjar.com/v2${path}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get("/nexus/regions", "nope")).status).toBe(401);
    expect((await get("/transactions/orders?from_transaction_date=2026-01-01&to_transaction_date=2026/12/31")).status).toBe(400);
    expect(await (await get("/transactions/orders?from_transaction_date=2026/10/28&to_transaction_date=2026/10/28")).json()).toEqual({ orders: ["T-1300"] });
    expect(await (await get("/transactions/orders?from_transaction_date=2026/01/01&to_transaction_date=2026/12/31&provider=shopify")).json()).toEqual({ orders: [] });
    expect((await get("/transactions/orders/T-1300?provider=shopify")).status).toBe(404);
    expect((await get("/transactions/orders/T-1300")).status).toBe(200);
  });
});
