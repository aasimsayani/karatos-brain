import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  QUICKBOOKS_TEST_REALM,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  qbAccount,
  qbBill,
  qbCustomer,
  qbInvoice,
  qbJournalEntry,
  qbPayment,
  qbVendor,
  quickBooksDocMock,
  tamper,
  testPipeline,
  type QuickBooksMock,
  type QuickBooksMockData,
} from "@karatos/connector-testkit";
import {
  QUICKBOOKS_ENTITIES,
  QUICKBOOKS_MINOR_VERSION,
  QUICKBOOKS_TOKEN_URL,
  QUICKBOOKS_WRITES,
  QuickBooksApiError,
  QuickBooksConfigError,
  memoryTokenStore,
  parseQuickBooksCursor,
  quickBooksCents,
  quickBooksClient,
  quickBooksConnector,
  quickBooksEvent,
  quickBooksEvents,
  quickBooksStatement,
  quickBooksWebhookChanges,
  verifyQuickBooksWebhook,
  type QuickBooksConnectorOptions,
  type QuickBooksCursor,
  type QuickBooksTokenStore,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["AB", "test", "0".repeat(40)].join("");
const CLIENT_SECRET = ["test", "secret", "0".repeat(28)].join("-");
const FIRST_REFRESH = ["RT", "TEST", "0"].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const API = `https://sandbox-quickbooks.api.intuit.com/v3/company/${QUICKBOOKS_TEST_REALM}`;

function company(overrides: Partial<QuickBooksMockData> = {}): QuickBooksMockData {
  for (const b of [qbAccount, qbCustomer, qbVendor, qbInvoice, qbBill, qbPayment, qbJournalEntry]) b.reset();
  const invoices = qbInvoice.many(3);
  // One record QuickBooks returned without its update time: it is dead-lettered, not given a made-up one.
  invoices[2]!.MetaData = { CreateTime: invoices[2]!.MetaData.CreateTime } as typeof invoices[2]["MetaData"];
  return {
    entities: {
      Account: qbAccount.many(3),
      Customer: [...qbCustomer.many(2), qbCustomer.one({ Active: false })],
      Vendor: qbVendor.many(2),
      Invoice: invoices,
      Bill: qbBill.many(2),
      Payment: qbPayment.many(1),
      JournalEntry: qbJournalEntry.many(1),
    },
    deleted: [{ entity: "Invoice", Id: "190", LastUpdatedTime: "2026-01-19T12:00:00Z" }],
    refreshToken: FIRST_REFRESH,
    now: NOW,
    ...overrides,
  };
}

const options = (mock: QuickBooksMock, extra: Partial<QuickBooksConnectorOptions> = {}): QuickBooksConnectorOptions => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  realmId: QUICKBOOKS_TEST_REALM,
  environment: "sandbox",
  tokens: memoryTokenStore(FIRST_REFRESH),
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: QuickBooksMock, extra: Partial<QuickBooksConnectorOptions> = {}) => quickBooksConnector(options(mock, extra));
const statements = (mock: QuickBooksMock) =>
  mock.fetch.calls.filter((c) => c.url.includes("/query")).map((c) => new URL(c.url).searchParams.get("query"));

describe("QuickBooks client", () => {
  it("checks its settings, naming them but never their values", () => {
    const mock = quickBooksDocMock(company());
    const base = options(mock);
    expect(() => quickBooksClient({ ...base, clientSecret: " " })).toThrow(new QuickBooksConfigError("set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET"));
    expect(() => quickBooksClient({ ...base, realmId: "abc" })).toThrow("QUICKBOOKS_REALM_ID must be the company's numeric Company ID");
    expect(() => quickBooksClient({ ...base, environment: "staging" })).toThrow("QUICKBOOKS_ENVIRONMENT must be production or sandbox");
    expect(() => quickBooksClient({ ...base, environment: " production " })).not.toThrow();
  });

  it("sends only SELECT queries and change data capture reads", async () => {
    const client = quickBooksClient(options(quickBooksDocMock(company())));
    for (const bad of [
      "DELETE FROM Invoice",
      "SELECT * FROM Invoice; DELETE FROM Invoice STARTPOSITION 1 MAXRESULTS 1",
      "select * from Invoice STARTPOSITION 1 MAXRESULTS 1",
      "SELECT Id FROM Invoice STARTPOSITION 1 MAXRESULTS 1",
      "SELECT * FROM Invoice",
    ]) {
      await expect(client.query(bad)).rejects.toThrow(new QuickBooksConfigError("the QuickBooks connector only sends SELECT queries"));
    }
    await expect(client.cdc([], "2026-01-01T00:00:00Z")).rejects.toThrow(QuickBooksConfigError);
    await expect(client.cdc(["Invoice&x=1"], "2026-01-01T00:00:00Z")).rejects.toThrow(QuickBooksConfigError);
    await expect(client.cdc(["Invoice"], "yesterday")).rejects.toThrow(QuickBooksConfigError);
  });

  it("gets with a bearer token and the pinned minor version, refreshing with Basic auth at Intuit", async () => {
    const mock = quickBooksDocMock(company());
    const seen: { method: string; url: string; auth: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization") ?? "" });
      return mock.fetch(request);
    };
    const client = quickBooksClient(options(mock, { fetch }));
    await client.query("SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 10");
    expect(seen.map((s) => [s.method, s.url.split("?")[0]])).toEqual([
      ["POST", QUICKBOOKS_TOKEN_URL],
      ["GET", `${API}/query`],
    ]);
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(seen[1]!.auth).toBe("Bearer AT-TEST-1");
    expect(new URL(seen[1]!.url).searchParams.get("minorversion")).toBe(String(QUICKBOOKS_MINOR_VERSION));
    expect(new URL("https://quickbooks.api.intuit.com").host).not.toBe(new URL(seen[1]!.url).host);
  });

  it("stores each rotated refresh token before using it, so a restart picks up the newest", async () => {
    const mock = quickBooksDocMock(company());
    const store = memoryTokenStore(FIRST_REFRESH);
    let t = 0;
    const client = quickBooksClient(options(mock, { tokens: store, clock: () => t }));
    await client.query("SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 10");
    expect(store.current).toBe("RT-TEST-1");
    // Within the hour the access token is reused.
    t = 50 * 60_000;
    await client.query("SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 10");
    expect(mock.refreshes).toBe(1);
    // Five minutes before it expires, it is renewed with the stored token.
    t = 56 * 60_000;
    await client.query("SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 10");
    expect([mock.refreshes, store.current]).toEqual([2, "RT-TEST-2"]);
    // A fresh client reading the store keeps working; the first token is long gone.
    await expect(quickBooksClient(options(mock, { tokens: store })).query("SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 10")).resolves.toBeDefined();
    await expect(quickBooksClient(options(mock)).query("SELECT * FROM Account STARTPOSITION 1 MAXRESULTS 10")).rejects.toThrow(/invalid_grant\); reconnect QuickBooks/);
  });

  it("refreshes once for queries that need a token at the same time", async () => {
    const mock = quickBooksDocMock(company());
    const client = quickBooksClient(options(mock));
    await Promise.all([1, 2, 3].map(() => client.query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")));
    expect(mock.refreshes).toBe(1);
  });

  it("keeps the old refresh token when storing the new one fails", async () => {
    const mock = quickBooksDocMock(company());
    const tokens: QuickBooksTokenStore = { load: async () => FIRST_REFRESH, save: async () => Promise.reject(new Error("database down")) };
    await expect(quickBooksClient(options(mock, { tokens })).query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")).rejects.toThrow("database down");
    const empty: QuickBooksTokenStore = { load: async () => " ", save: async () => {} };
    await expect(quickBooksClient(options(mock, { tokens: empty })).query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")).rejects.toThrow("set QUICKBOOKS_REFRESH_TOKEN");
  });

  it("refreshes once when an access token is revoked early, then gives up", async () => {
    const mock = quickBooksDocMock(company());
    const client = quickBooksClient(options(mock));
    await client.query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10");
    mock.revokeAccessTokens();
    await client.query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10");
    expect(mock.refreshes).toBe(2);
    const always401: typeof globalThis.fetch = async (input, init) =>
      String(input).startsWith(QUICKBOOKS_TOKEN_URL) ? mock.fetch(input as string, init) : new Response("{}", { status: 401 });
    await expect(quickBooksClient(options(mock, { fetch: always401, tokens: memoryTokenStore(mock.refreshToken) })).query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")).rejects.toThrow(
      new QuickBooksApiError("QuickBooks answered HTTP 401", 401),
    );
  });

  it("backs off on 429 and gives up after its retries, leaving the error to runSync", async () => {
    const mock = quickBooksDocMock(company());
    const waits: number[] = [];
    let limited = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(QUICKBOOKS_TOKEN_URL)) return mock.fetch(input as string, init);
      limited++;
      return new Response(JSON.stringify({ Fault: { Error: [{ Message: "ThrottleExceeded", code: "003001" }] } }), { status: 429 });
    };
    const error = await quickBooksClient(options(mock, { fetch, sleep: async (ms) => void waits.push(ms) }))
      .query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")
      .catch((e: unknown) => e);
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(limited).toBe(4);
    expect(error).toMatchObject({ name: "QuickBooksApiError", status: 429, code: "003001", message: "QuickBooks answered HTTP 429: ThrottleExceeded" });
  });

  it("reports Intuit's faults, including ones sent with HTTP 200, and never a token or secret", async () => {
    const mock = quickBooksDocMock(company());
    const client = quickBooksClient(options(mock));
    const parse = await client.query("SELECT * FROM Invoice WHERE DocNumber = 'X' STARTPOSITION 1 MAXRESULTS 10").then(() => new QuickBooksApiError("did not fail", 0), (e: unknown) => e as QuickBooksApiError);
    expect(parse).toMatchObject({ status: 400, code: "4000" });
    expect(parse.message).toMatch(/^QuickBooks answered HTTP 400: QueryParserError: unsupported condition DocNumber/);
    const ok200: typeof globalThis.fetch = async (input, init) =>
      String(input).startsWith(QUICKBOOKS_TOKEN_URL) ? mock.fetch(input as string, init) : new Response(JSON.stringify({ Fault: { Error: [{ Message: "x".repeat(500), code: "6000" }] } }), { status: 200 });
    const fault = await quickBooksClient(options(mock, { fetch: ok200, tokens: memoryTokenStore(mock.refreshToken) }))
      .query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")
      .then(() => new QuickBooksApiError("did not fail", 0), (e: unknown) => e as QuickBooksApiError);
    expect(fault).toMatchObject({ code: "6000" });
    expect(fault.message.length).toBeLessThan(260);
    const refused = await quickBooksClient(options(mock, { tokens: memoryTokenStore(FIRST_REFRESH) })).query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10").then(() => new Error("did not fail"), (e: unknown) => e as Error);
    for (const message of [parse.message, fault.message, refused.message]) {
      for (const secret of [CLIENT_ID, CLIENT_SECRET, FIRST_REFRESH, "AT-TEST", "RT-TEST-1"]) expect(message).not.toContain(secret);
    }
  });

  it("routes the mock by exact host, so a look-alike sign-in host is refused", async () => {
    const mock = quickBooksDocMock(company());
    await expect(mock.fetch("https://oauth.platform.intuit.com.example.test/oauth2/v1/tokens/bearer", { method: "POST" })).rejects.toThrow(/not in the vendor's docs/);
  });

  it("refuses answers that aren't a query or CDC response", async () => {
    const mock = quickBooksDocMock(company());
    const odd: typeof globalThis.fetch = async (input, init) => (String(input).startsWith(QUICKBOOKS_TOKEN_URL) ? mock.fetch(input as string, init) : new Response("[]", { status: 200 }));
    const client = quickBooksClient(options(mock, { fetch: odd }));
    await expect(client.query("SELECT * FROM Vendor STARTPOSITION 1 MAXRESULTS 10")).rejects.toThrow("QuickBooks did not answer with a QueryResponse");
    await expect(client.cdc(["Vendor"], "2026-01-19T00:00:00Z")).rejects.toThrow("QuickBooks did not answer with a CDCResponse");
  });
});

describe("QuickBooks normalization", () => {
  it("keeps the books' money, dates and links, and nothing personal", () => {
    const data = company();
    const events = QUICKBOOKS_ENTITIES.flatMap((e) => quickBooksEvents(e, data.entities[e], RECEIVED));
    const text = JSON.stringify(events.map((e) => e.payload));
    for (const personal of ["@", "555", "Test Street", "Testville", "XXXXX0000", "Synthetic memo", "Synthetic note"]) expect(text).not.toContain(personal);
    const invoice = events.find((e) => e.type === "accounting.invoice_updated")!;
    expect(invoice).toMatchObject({
      idempotencyKey: "quickbooks:invoice:101:0",
      occurredAt: "2026-01-01T01:30:00.000Z",
      payload: {
        invoiceId: "quickbooks:invoice:101",
        number: "INV-TEST-1",
        customerId: "quickbooks:customer:1",
        txnDate: "2026-01-02",
        totalCents: 125_050,
        balanceCents: 125_050,
        currency: "USD",
        lines: [{ amountCents: 125_050, item: "Test 14K ring", quantity: 1 }],
      },
    });
    expect(events.find((e) => e.type === "accounting.payment_updated")!.payload).toMatchObject({ totalCents: 50_000, appliedTo: [{ type: "Invoice", id: "101", amountCents: 50_000 }] });
    expect(events.find((e) => e.type === "accounting.journal_entry_updated")!.payload.lines).toEqual([
      { amountCents: 7_500, posting: "debit", accountId: "quickbooks:account:3", accountName: "Test Account 3" },
      { amountCents: 7_500, posting: "credit", accountId: "quickbooks:account:1", accountName: "Test Account 1" },
    ]);
    expect(events.find((e) => e.type === "accounting.bill_updated")!.payload).toMatchObject({ vendorId: "quickbooks:vendor:51", vendorName: "Test Supplier 1", totalCents: 64_000 });
    expect(events.find((e) => e.type === "accounting.account_updated")!.payload).toMatchObject({ accountType: "Bank", currentBalanceCents: 100_100, active: true });
    expect(events.find((e) => e.type === "customer.profile_updated")!.payload).toEqual({ customerId: "quickbooks:customer:1", name: "Test Customer 1", marketingConsent: false });
  });

  it("stores a new version when the SyncToken moves, and a deletion once", () => {
    qbAccount.reset();
    const [account] = qbAccount.many(1);
    expect(quickBooksEvent("Account", account!, RECEIVED)!.idempotencyKey).toBe("quickbooks:account:1:0");
    expect(quickBooksEvent("Account", { ...account!, SyncToken: "4" }, RECEIVED)!.idempotencyKey).toBe("quickbooks:account:1:4");
    expect(quickBooksEvent("Account", { ...account!, SyncToken: "../x" }, RECEIVED)!.idempotencyKey).toBe("quickbooks:account:1:0");
    expect(quickBooksEvent("JournalEntry", { Id: "9", status: "Deleted", MetaData: { LastUpdatedTime: "2026-01-19T12:00:00-08:00" } }, RECEIVED)).toEqual({
      id: "quickbooks_journal_entry:9:deleted",
      type: "accounting.record_deleted",
      occurredAt: "2026-01-19T20:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "quickbooks:journal_entry:9:deleted",
      payload: { recordId: "quickbooks:journal_entry:9", entity: "journal_entry" },
    });
  });

  it("drops records with no usable Id, and dead-letters ones with no update time instead of inventing one", () => {
    expect(quickBooksEvent("Vendor", { DisplayName: "No id" }, RECEIVED)).toBeNull();
    expect(quickBooksEvent("Vendor", { Id: "1/../2" }, RECEIVED)).toBeNull();
    expect(quickBooksEvent("Vendor", { Id: "7", MetaData: { LastUpdatedTime: "soon" } }, RECEIVED)!.occurredAt).toBeUndefined();
    expect(quickBooksEvents("Vendor", "not a list", RECEIVED)).toEqual([]);
  });

  it("names unnamed customers and vendors, and keeps amounts it can't read as null", () => {
    expect(quickBooksEvent("Customer", { Id: "3", DisplayName: "  " }, RECEIVED)!.payload.name).toBe("QuickBooks customer 3");
    expect(quickBooksEvent("Vendor", { Id: "4" }, RECEIVED)!.payload).toMatchObject({ name: "QuickBooks vendor 4", balanceCents: null });
    expect([quickBooksCents(10.005), quickBooksCents(-0.1), quickBooksCents("5"), quickBooksCents(Number.NaN)]).toEqual([1001, -10, null, null]);
    expect(quickBooksEvent("Invoice", { Id: "5", Line: "x", CustomerRef: {} }, RECEIVED)!.payload).toEqual({ invoiceId: "quickbooks:invoice:5", totalCents: null, balanceCents: null, lines: [] });
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(company())).not.toThrow();
  });
});

describe("QuickBooks sync", () => {
  it("imports, replays, resumes and retries the mocked company", async () => {
    // 3 accounts, 3 customers (one inactive), 2 vendors, 3 invoices (one dead-lettered), 2 bills, a payment and a journal entry.
    const result = await checkConnectorSync({ makeConnector: () => connector(quickBooksDocMock(company())), expected: { ingested: 14, deadLettered: 1 } });
    expect(result.full.batches).toBe(7);
    expect(parseQuickBooksCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", position: 1 });
  });

  it("queries each entity six years back, inactive names included, paging 1000 at a time", async () => {
    const mock = quickBooksDocMock(company({ entities: { ...company().entities, Invoice: qbInvoice.many(1001) } }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.batches).toBe(8);
    expect(statements(mock)).toEqual([
      "SELECT * FROM Account WHERE Active IN (true, false) ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "SELECT * FROM Customer WHERE Active IN (true, false) ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "SELECT * FROM Vendor WHERE Active IN (true, false) ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "SELECT * FROM Invoice WHERE TxnDate >= '2020-01-20' ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "SELECT * FROM Invoice WHERE TxnDate >= '2020-01-20' ORDERBY Id STARTPOSITION 1001 MAXRESULTS 1000",
      "SELECT * FROM Bill WHERE TxnDate >= '2020-01-20' ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "SELECT * FROM Payment WHERE TxnDate >= '2020-01-20' ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
      "SELECT * FROM JournalEntry WHERE TxnDate >= '2020-01-20' ORDERBY Id STARTPOSITION 1 MAXRESULTS 1000",
    ]);
    expect(mock.fetch.calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([QUICKBOOKS_TOKEN_URL]);
    expect(report.ingested).toBe(1001 + 12);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(quickBooksDocMock(company())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 14, deadLettered: 1 });
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === "customer.profile_updated")).toHaveLength(3);
    expect(new Set(types)).toEqual(new Set(["accounting.account_updated", "customer.profile_updated", "accounting.vendor_updated", "accounting.invoice_updated", "accounting.bill_updated", "accounting.payment_updated", "accounting.journal_entry_updated"]));
  });

  it("leaves a finished import finished", async () => {
    const done: QuickBooksCursor = { pass: "historical", step: "done", position: 1, since: "2020-01-20T00:00:00.000Z", nextFrom: RECEIVED };
    const mock = quickBooksDocMock(company());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("reads changes since the last pass started, then deletions, and starts the next pass a little before this one", async () => {
    const data = company();
    data.entities.Vendor![0]!.MetaData.LastUpdatedTime = "2026-01-19T10:00:00Z";
    const mock = quickBooksDocMock(data);
    const previous: QuickBooksCursor = { pass: "incremental", step: "done", position: 1, since: "2026-01-18T00:00:00.000Z", nextFrom: "2026-01-19T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "quickbooks", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Change data capture also lists the changed vendor; only deletions are taken from it, so nothing is read twice.
    expect(report).toMatchObject({ ingested: 2, duplicates: 0, batches: 8 });
    expect(statements(mock)[2]).toBe("SELECT * FROM Vendor WHERE Active IN (true, false) AND MetaData.LastUpdatedTime >= '2026-01-19T00:00:00+00:00' ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 1000");
    expect(statements(mock)[3]).toBe("SELECT * FROM Invoice WHERE MetaData.LastUpdatedTime >= '2026-01-19T00:00:00+00:00' ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 1000");
    const cdc = new URL(mock.fetch.calls.at(-1)!.url);
    expect([cdc.pathname.endsWith("/cdc"), cdc.searchParams.get("entities"), cdc.searchParams.get("changedSince")]).toEqual([true, QUICKBOOKS_ENTITIES.join(","), "2026-01-19T00:00:00+00:00"]);
    expect(memory.events.map((e) => e.type).sort()).toEqual(["accounting.record_deleted", "accounting.vendor_updated"]);
    expect(parseQuickBooksCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", position: 1, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:55:00.000Z" });
  });

  it("looks back 48 hours with no checkpoint, and asks for deletions no further back than change data capture keeps", async () => {
    const fresh = quickBooksDocMock(company());
    const first = await runSync({ connector: connector(fresh), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(statements(fresh)[0]).toContain("MetaData.LastUpdatedTime >= '2026-01-18T00:00:00+00:00'");
    expect(first.deadLettered).toBe(0);
    const stale = quickBooksDocMock(company());
    const old: QuickBooksCursor = { pass: "incremental", step: "done", position: 1, since: "2025-10-01T00:00:00.000Z", nextFrom: "2025-11-01T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "quickbooks", "incremental", JSON.stringify(old));
    await runSync({ connector: connector(stale), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(statements(stale)[0]).toContain("'2025-11-01T00:00:00+00:00'");
    expect(new URL(stale.fetch.calls.at(-1)!.url).searchParams.get("changedSince")).toBe("2025-12-21T01:00:00+00:00");
  });

  it("resumes an interrupted incremental pass at the page it stopped on", async () => {
    const mock = quickBooksDocMock(company());
    const stopped: QuickBooksCursor = { pass: "incremental", step: "Bill", position: 1001, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:00:00.000Z" };
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) batches.push(b);
    expect(statements(mock)[0]).toBe("SELECT * FROM Bill WHERE MetaData.LastUpdatedTime >= '2026-01-19T00:00:00+00:00' ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1001 MAXRESULTS 1000");
    expect(batches).toHaveLength(4);
    expect(parseQuickBooksCursor(batches.at(-1)!.cursor)!.nextFrom).toBe("2026-01-19T23:00:00.000Z");
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: QuickBooksCursor = { pass: "incremental", step: "Invoice", position: 1, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:00:00.000Z" };
    expect(parseQuickBooksCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "Item" },
      { ...good, pass: "historical", step: "deletions" },
      { ...good, position: 0 },
      { ...good, position: 1.5 },
      { ...good, since: "2026-01-19' OR 1=1" },
      { ...good, nextFrom: "2026-13-45T00:00:00Z" },
      { ...good, since: "2026-01-19" },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      null,
    ]) {
      expect(() => parseQuickBooksCursor(JSON.stringify(bad))).toThrow("QuickBooks checkpoint is not in the expected shape");
    }
  });

  it("builds every statement from its own dates, so a query can't carry outside text", () => {
    const cursor: QuickBooksCursor = { pass: "historical", step: "Invoice", position: 1, since: "2020-01-20T00:00:00.000Z", nextFrom: RECEIVED };
    for (const entity of QUICKBOOKS_ENTITIES) expect(quickBooksStatement(entity, cursor)).not.toMatch(/['"].*[;\\]/);
    expect(() => parseQuickBooksCursor(JSON.stringify({ ...cursor, since: "x'; DELETE" }))).toThrow();
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(quickBooksDocMock(company()));
    expect(c.writes).toBe(QUICKBOOKS_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => a.action)).toEqual(["create_invoice", "create_bill", "create_journal_entry"]);
  });
});

describe("QuickBooks webhooks", () => {
  const TOKEN = ["verifier", "test", "0".repeat(20)].join("-");
  const body = JSON.stringify([
    { specversion: "1.0", id: "e-1", source: "intuit.test", type: "qbo.invoice.updated.v1", datacontenttype: "application/json", time: "2026-01-19T12:00:00Z", intuitentityid: "101", intuitaccountid: QUICKBOOKS_TEST_REALM, data: {} },
    { specversion: "1.0", id: "e-2", source: "intuit.test", type: "qbo.journalentry.deleted.v1", time: "2026-01-19T12:01:00Z", intuitentityid: "401", intuitaccountid: QUICKBOOKS_TEST_REALM },
    { specversion: "1.0", id: "e-3", source: "intuit.test", type: "qbo.invoice.created.v1", intuitentityid: "102", intuitaccountid: "1111111111" },
    { specversion: "1.0", id: "e-4", source: "intuit.test", type: "qbo.item.updated.v1", intuitentityid: "7", intuitaccountid: QUICKBOOKS_TEST_REALM },
    { specversion: "1.0", id: "e-5", source: "intuit.test", type: "qbo.customer.merged.v1", intuitentityid: "../1", intuitaccountid: QUICKBOOKS_TEST_REALM },
  ]);

  it("accepts a correctly signed delivery and rejects tampered, unsigned, wrongly keyed or malformed ones", () => {
    const signature = hmacSha256(TOKEN, body, "base64");
    expect(verifyQuickBooksWebhook(TOKEN, body, signature)).toEqual({ ok: true });
    expect(verifyQuickBooksWebhook(TOKEN, Buffer.from(body), ` ${signature} `)).toEqual({ ok: true });
    expect(verifyQuickBooksWebhook(TOKEN, tamper(body), signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyQuickBooksWebhook(`${TOKEN}x`, body, signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyQuickBooksWebhook(TOKEN, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyQuickBooksWebhook("", body, signature)).toEqual({ ok: false, reason: "missing" });
    expect(verifyQuickBooksWebhook(TOKEN, body, hmacSha256(TOKEN, body, "hex"))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyQuickBooksWebhook(TOKEN, body, "A".repeat(43))).toEqual({ ok: false, reason: "malformed" });
  });

  it("treats a replayed delivery as a prompt to sync, which stores nothing twice", async () => {
    expect(verifyQuickBooksWebhook(TOKEN, body, hmacSha256(TOKEN, body, "base64"))).toEqual({ ok: true });
    const mock = quickBooksDocMock(company());
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const again = await runSync({ connector: connector(mock, { tokens: memoryTokenStore(mock.refreshToken) }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect(again.ingested).toBe(0);
  });

  it("lists this company's changes to entities the connector reads, and nothing else", () => {
    expect(quickBooksWebhookChanges(JSON.parse(body), QUICKBOOKS_TEST_REALM)).toEqual([
      { entity: "Invoice", id: "101", operation: "updated", time: "2026-01-19T12:00:00Z" },
      { entity: "JournalEntry", id: "401", operation: "deleted", time: "2026-01-19T12:01:00Z" },
    ]);
    expect(quickBooksWebhookChanges({ eventNotifications: [] }, QUICKBOOKS_TEST_REALM)).toEqual([]);
    expect(quickBooksWebhookChanges([null, { specversion: "0.3", type: "qbo.invoice.updated.v1", intuitentityid: "1", intuitaccountid: QUICKBOOKS_TEST_REALM }], QUICKBOOKS_TEST_REALM)).toEqual([]);
  });
});
