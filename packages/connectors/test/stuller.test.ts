import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, docMockFetch, stullerDocMock, stullerInvoice, stullerInvoiceDetail, testPipeline, type StullerInvoice, type StullerMockData } from "@karatos/connector-testkit";
import {
  STULLER_API,
  STULLER_EVENT_TYPES,
  STULLER_WRITES,
  StullerApiError,
  StullerConfigError,
  invoiceEvent,
  metalRatesEvent,
  parseStullerCursor,
  stullerCents,
  stullerClient,
  stullerConnector,
  stullerTime,
  stullerWeight,
  type StullerEvent,
  type StullerOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-10-26T12:00:00Z");
const RECEIVED = "2026-10-26T12:00:00.000Z";
const USER = "karatos-dev";
// Shaped like a Stuller developer password, assembled so no scanner mistakes it for a real one.
const PASSWORD = ["test", "stuller", "x".repeat(16)].join("-");
const noSleep = async () => {};

stullerInvoice.reset();
stullerInvoiceDetail.reset();
const INVOICES = stullerInvoice.many(3);
const RATES: StullerMockData["metalRates"] = [
  { Type: "Gold", Rate: 2742.1 },
  { Type: "Silver", Rate: 32.18 },
  { Type: "Platinum", Rate: 1001.5 },
  { Type: "Palladium", Rate: 1100 },
];

const data = (extra: Partial<StullerMockData> = {}): StullerMockData => ({ invoices: INVOICES, metalRates: RATES, login: { username: USER, password: PASSWORD }, ...extra });
const mockFetch = (extra: Partial<StullerMockData> = {}) => docMockFetch(stullerDocMock(data(extra)));

function connector(fetch: typeof globalThis.fetch = mockFetch(), extra: Partial<StullerOptions> = {}) {
  return stullerConnector({ username: USER, password: PASSWORD, fetch, sleep: noSleep, now: NOW, batchSize: 2, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as StullerEvent[]);
const answering = (status: number, body: string, headers: Record<string, string> = {}): typeof globalThis.fetch => async () => new Response(body, { status, headers });
const client = (fetch: typeof globalThis.fetch, extra = {}) => stullerClient({ username: USER, password: PASSWORD, fetch, sleep: noSleep, ...extra });

describe("Stuller client", () => {
  it("reads invoices and metal rates with GETs and Basic auth, at Stuller's address only", async () => {
    const fetch = mockFetch();
    const c = client(fetch);
    expect(await c.invoices()).toEqual(INVOICES);
    expect(await c.metalRates()).toEqual(RATES);
    expect(fetch.calls).toEqual([
      { method: "GET", url: `${STULLER_API}/api/v2/invoice` },
      { method: "GET", url: `${STULLER_API}/api/v2/products/metalmarketrates` },
    ]);
  });

  it("says when the login is turned down or not allowed, never showing the password", async () => {
    const wrong = await stullerClient({ username: USER, password: "x".repeat(12), fetch: mockFetch() }).invoices().catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(StullerApiError);
    expect(wrong).toMatchObject({ status: 401, message: expect.stringMatching(/turned down the login.*Developer role/) });
    expect(String((wrong as Error).message)).not.toContain(PASSWORD);
    await expect(client(answering(403, "{}")).metalRates()).rejects.toThrow(/isn't allowed to read metal market rates/);
  });

  it("reads odd answers as errors", async () => {
    await expect(client(answering(500, "{}")).invoices()).rejects.toMatchObject({ status: 500, message: "Stuller answered HTTP 500 for invoices" });
    await expect(client(answering(200, "<html>")).invoices()).rejects.toThrow(/invoices with a body that isn't JSON/);
    await expect(client(answering(200, JSON.stringify({ Orders: [] }))).invoices()).rejects.toThrow(/without the Invoices list/);
    await expect(client(answering(200, "null")).metalRates()).rejects.toThrow(/without the MetalMarkets list/);
  });

  it("waits out a 429 as Retry-After says, capped, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    let throttled = 2;
    const inner = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) => (throttled-- > 0 ? new Response("", { status: 429, headers: { "retry-after": "3" } }) : inner(input, init));
    expect(await client(fetch, { sleep }).invoices()).toHaveLength(3);
    expect(waits).toEqual([3000, 3000]);
    waits.length = 0;
    await expect(client(answering(429, "", { "retry-after": "900" }), { sleep, rateLimitRetries: 2 }).invoices()).rejects.toMatchObject({ status: 429 });
    expect(waits).toEqual([60000, 60000]);
    waits.length = 0;
    await expect(client(answering(429, ""), { sleep, rateLimitRetries: 2 }).invoices()).rejects.toThrow(StullerApiError);
    expect(waits).toEqual([1000, 2000]);
  });

  it("checks its settings before sending anything", () => {
    expect(() => stullerClient({ username: "a:b", password: PASSWORD })).toThrow(StullerConfigError);
    expect(() => stullerClient({ username: USER, password: "short" })).toThrow(/STULLER_PASSWORD/);
  });
});

describe("Stuller invoice reading", () => {
  it("reads amounts, weights and times, returning null rather than guessing", () => {
    expect([stullerCents(251), stullerCents("0.00"), stullerCents("$1,250.50"), stullerCents(-12.5), stullerCents(1.005), stullerCents("n/a"), stullerCents(null), stullerCents(Number.NaN)]).toEqual([25100, 0, 125050, -1250, 101, null, null, null]);
    expect([stullerWeight("2.10 DWT"), stullerWeight("1.5g"), stullerWeight("heavy"), stullerWeight(undefined)]).toEqual([{ amount: 2.1, unit: "DWT" }, { amount: 1.5, unit: "G" }, null, null]);
    expect([stullerTime("2026-01-02T01:00:00Z"), stullerTime("2026-01-02T01:00:00"), stullerTime("2026-01-02T01:00:00-05:00"), stullerTime("2026-01-02"), stullerTime("2026-02-30"), stullerTime("01/02/2026"), stullerTime("")]).toEqual([
      "2026-01-02T01:00:00.000Z",
      "2026-01-02T01:00:00.000Z",
      "2026-01-02T06:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      null,
      null,
      null,
    ]);
  });

  it("reads a time without a zone as UTC wherever the server runs", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(stullerTime("2026-01-02T01:00:00")).toBe("2026-01-02T01:00:00.000Z");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("leaves out labor charges and metal rates the invoice doesn't have", () => {
    const inv = { ...INVOICES[0]!, GoldMarketRate: 0, SilverMarketRate: null, InvoiceDetails: [{ ...INVOICES[0]!.InvoiceDetails[0]!, LaborOtherCharges: "" }] };
    const read = invoiceEvent(inv, RECEIVED);
    expect(read.ok).toBe(true);
    expect(read.event.payload.metalRates).toEqual({ gold: undefined, silver: undefined, platinum: { perTroyOunceCents: 100000, baseCents: 95000, adderCents: 0 } });
    expect((read.event.payload.lines as { laborOtherChargesCents: unknown }[])[0]!.laborOtherChargesCents).toBeNull();
  });

  it("names everything in an invoice that doesn't read, and dead-letters it", () => {
    const broken = { ...INVOICES[0]!, InvoiceNumber: "../1", InvoiceDate: "soon", OrderDate: "later", InvoiceTotal: "lots", InvoiceDetails: [{ ...INVOICES[0]!.InvoiceDetails[0]!, ItemNumber: "", UnitPrice: "x", LaborOtherCharges: "?" }] };
    const read = invoiceEvent(broken, RECEIVED);
    expect(read.ok).toBe(false);
    expect(read.invoiceNumber).toBeNull();
    expect(read.event.occurredAt).toBeUndefined();
    expect(read.event.payload.problems).toEqual([
      "has no invoice number that reads",
      "has no invoice date that reads",
      "has an order date that doesn't read",
      "has an unreadable InvoiceTotal",
      "line 1 has no item number",
      "line 1 has an unreadable UnitPrice",
      "line 1 has an unreadable LaborOtherCharges",
    ]);
    expect(invoiceEvent("junk", RECEIVED).event.payload.problems).toEqual(expect.arrayContaining(["is not an invoice", "has no InvoiceDetails list"]));
    expect(invoiceEvent({ ...INVOICES[1]!, InvoiceDetails: null }, RECEIVED)).toMatchObject({ ok: false, invoiceNumber: INVOICES[1]!.InvoiceNumber });
  });

  it("reads Stuller's rates once each, skipping ones that don't read, and nothing from an empty list", () => {
    const e = metalRatesEvent([...RATES, { Type: "Rhodium", Rate: 5 }, { Type: "Gold ", Rate: "bad" }, null], RECEIVED)!;
    expect(e.payload.perTroyOunceCents).toEqual({ gold: 274210, silver: 3218, platinum: 100150, palladium: 110000 });
    expect(metalRatesEvent([], RECEIVED)).toBeNull();
    expect(metalRatesEvent([{ Type: "Gold", Rate: 0 }], RECEIVED)).toBeNull();
  });
});

describe("Stuller connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data());
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 4 } });
    expect(result.full.batches).toBe(2);
    expect((await collect(connector().historicalImport({ organizationId: TEST_ORG, cursor: null }))).map((b) => b.events.length)).toEqual([2, 2]);
    expect(Object.keys(parseStullerCursor(result.full.cursor!)!.invoices)).toEqual(INVOICES.map((i) => i.InvoiceNumber));
  });

  it("records each invoice's lines, totals, status and metal rates, without the ship-to address or tracking link", async () => {
    const [first] = await eventsOf();
    const inv = INVOICES[0]!;
    expect(first).toEqual({
      id: expect.stringMatching(/^stuller_invoice:INV-TEST-1:[0-9a-f]{12}$/),
      type: STULLER_EVENT_TYPES.invoice,
      occurredAt: inv.InvoiceDate,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^stuller:invoice:INV-TEST-1:[0-9a-f]{12}$/),
      payload: {
        vendor: "Stuller",
        invoiceNumber: "INV-TEST-1",
        orderNumber: "ORD-TEST-1",
        purchaseOrderNumber: "PO-TEST-1",
        shipToAccount: "ACCT-TEST-1",
        status: "Shipped",
        invoiceDate: inv.InvoiceDate,
        orderDate: inv.OrderDate,
        currency: "USD",
        orderCents: 50300,
        invoiceCents: 51500,
        dueCents: 51500,
        salesTaxCents: 0,
        shippingCents: 1200,
        shipMethod: "Test Ground",
        trackingNumber: "TRACK-TEST-1",
        metalRates: {
          gold: { perTroyOunceCents: 270000, baseCents: 260000, adderCents: 0 },
          silver: { perTroyOunceCents: 3200, baseCents: 3000, adderCents: 0 },
          platinum: { perTroyOunceCents: 100000, baseCents: 95000, adderCents: 0 },
        },
        lines: [
          { lineNumber: 1, customerLineReference: "LINE-TEST-1", itemNumber: inv.InvoiceDetails[0]!.ItemNumber, description: "Test 14K yellow solitaire mounting 1", shipQuantity: 1, backOrderedQuantity: 0, unitOfMeasure: "EA", unitPriceCents: 25100, lineTotalCents: 25100, laborOtherChargesCents: 0, weight: { amount: 2.1, unit: "DWT" }, notes: undefined },
          expect.objectContaining({ lineNumber: 2, unitPriceCents: 25200 }),
        ],
      },
    });
    const json = JSON.stringify(first);
    expect(json).not.toContain("Test Street");
    expect(json).not.toContain("Testville");
    expect(json).not.toContain("https://");
  });

  it("records Stuller's current metal rates when they change, and not when they don't", async () => {
    const rates = [...RATES];
    const fetch = mockFetch({ metalRates: rates });
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(fetch), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    await sync();
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 1 });
    rates[0] = { Type: "Gold", Rate: 2800 };
    expect(await sync()).toMatchObject({ ingested: 1 });
    expect(memory.events.filter((e) => e.type === STULLER_EVENT_TYPES.metalRates).map((e) => (e.payload.perTroyOunceCents as Record<string, number>).gold)).toEqual([274210, 280000]);
    expect((await eventsOf(connector(fetch, { metalRates: false }))).map((e) => e.type)).not.toContain(STULLER_EVENT_TYPES.metalRates);
  });

  it("records an invoice again when its status or tracking changes, and nothing for unchanged ones", async () => {
    const invoices: StullerInvoice[] = [...INVOICES];
    const fetch = mockFetch({ invoices });
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(fetch, { metalRates: false }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 3 });
    invoices[1] = { ...invoices[1]!, Status: "Delivered", TrackingNumber: "TRACK-TEST-2B" };
    invoices.push(stullerInvoice.one());
    expect(await sync()).toMatchObject({ ingested: 2, duplicates: 0 });
    expect(memory.events.slice(3).map((e) => [e.payload.invoiceNumber, e.payload.status])).toEqual([
      ["INV-TEST-2", "Delivered"],
      ["INV-TEST-4", "Shipped"],
    ]);
  });

  it("reads oldest first and skips invoices older than the history window", async () => {
    const old = { ...INVOICES[0]!, InvoiceNumber: "INV-OLD", InvoiceDate: "2020-01-02T00:00:00Z" };
    const late = { ...INVOICES[0]!, InvoiceNumber: "INV-LATE-0", InvoiceDate: "2026-10-01T00:00:00Z" };
    const events = await eventsOf(connector(mockFetch({ invoices: [late, INVOICES[2]!, old, INVOICES[0]!] }), { metalRates: false }));
    expect(events.map((e) => e.payload.invoiceNumber)).toEqual(["INV-TEST-1", "INV-TEST-3", "INV-LATE-0"]);
    const longer = await eventsOf(connector(mockFetch({ invoices: [old] }), { metalRates: false, historyYears: 7 }));
    expect(longer.map((e) => e.payload.invoiceNumber)).toEqual(["INV-OLD"]);
  });

  it("dead-letters an invoice that doesn't read, keeping it and the rest", async () => {
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mockFetch({ invoices: [{ ...INVOICES[0]!, InvoiceTotal: "TBD" as unknown as number }, INVOICES[1]!] })), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 2, deadLettered: 1 });
    expect(memory.deadLetters.map((d) => d.issues.map((i) => i.path))).toEqual([["occurredAt"]]);
  });

  it("stops the sync on a login Stuller turns down", async () => {
    const { memory, pipeline } = testPipeline();
    const bad = stullerConnector({ username: USER, password: "y".repeat(12), fetch: mockFetch(), sleep: noSleep });
    await expect(runSync({ connector: bad, mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/turned down the login/);
    expect(memory.events).toEqual([]);
  });

  it("runs the same way incrementally, takes no webhooks, and has every write turned down while writes are off", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("stuller");
    expect(c.handleWebhook).toBeUndefined();
    expect(c.writes).toBe(STULLER_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([["submit_order", "refused"]]);
    expect(stullerConnector({ username: USER, password: PASSWORD }).source).toBe("stuller");
    expect(() => connector(mockFetch(), { historyYears: 0 })).toThrow(/historyYears must be a positive whole number/);
    expect(() => connector(mockFetch(), { batchSize: -1 })).toThrow(/batchSize must be/);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good = { invoices: { "INV-TEST-1": "0123456789ab" } };
    expect(parseStullerCursor(null)).toBeNull();
    expect(parseStullerCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of ["null", "{}", "[]", JSON.stringify({ invoices: [] }), JSON.stringify({ invoices: { "../x": "0123456789ab" } }), JSON.stringify({ invoices: { "INV-1": "short" } })]) {
      expect(() => parseStullerCursor(bad), bad).toThrow(/Stuller checkpoint is not in the expected shape/);
    }
  });
});
