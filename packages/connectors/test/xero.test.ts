import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  TEST_ORG,
  XERO_MOCK_READ_SCOPES,
  XERO_TEST_TENANT,
  assertSynthetic,
  assertWritesRefused,
  checkConnectorSync,
  hmacSha256,
  tamper,
  testPipeline,
  xeroAccount,
  xeroBankTransaction,
  xeroBill,
  xeroContact,
  xeroCreditNote,
  xeroDocMock,
  xeroGuid,
  xeroInvoice,
  xeroManualJournal,
  xeroMsDate,
  xeroPayment,
  type XeroMock,
  type XeroMockData,
} from "@karatos/connector-testkit";
import {
  XERO_API_URL,
  XERO_ENDPOINTS,
  XERO_READ_SCOPES,
  XERO_TOKEN_URL,
  XERO_WRITES,
  XeroApiError,
  XeroConfigError,
  memoryTokenStore,
  parseXeroCursor,
  xeroCents,
  xeroClient,
  xeroConnector,
  xeroDateFilter,
  xeroEvents,
  xeroPageEvents,
  xeroTime,
  xeroTokenScopes,
  xeroWebhookChanges,
  xeroWriteScopes,
  verifyXeroWebhook,
  type XeroConnectorOptions,
  type XeroCursor,
  type XeroTokenStore,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const CLIENT_ID = ["TEST", "0".repeat(28)].join("");
const CLIENT_SECRET = ["test", "secret", "0".repeat(36)].join("-");
const FIRST_REFRESH = ["RT", "TEST", "0"].join("-");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const DELETED_INVOICE = xeroGuid("19", 1);

function organisation(overrides: Partial<XeroMockData> = {}): XeroMockData {
  for (const b of [xeroAccount, xeroContact, xeroInvoice, xeroBill, xeroCreditNote, xeroPayment, xeroBankTransaction, xeroManualJournal]) b.reset();
  const invoices = xeroInvoice.many(3);
  // One record Xero returned without its update time: it is dead-lettered, not given a made-up one.
  delete (invoices[2] as Partial<typeof invoices[2]>).UpdatedDateUTC;
  return {
    records: {
      Accounts: xeroAccount.many(3),
      Contacts: [
        ...xeroContact.many(2),
        xeroContact.one({ IsCustomer: false, IsSupplier: true, Name: "Test Supplier 1" }),
        xeroContact.one({ ContactStatus: "ARCHIVED" }),
        // Neither customer nor supplier yet: nothing for the departments.
        xeroContact.one({ IsCustomer: false }),
      ],
      Invoices: [
        ...invoices,
        { ...xeroInvoice.one(), InvoiceID: DELETED_INVOICE, Status: "DELETED", UpdatedDateUTC: xeroMsDate("2026-01-19T12:00:00Z") },
        ...xeroBill.many(2),
      ],
      CreditNotes: xeroCreditNote.many(1),
      Payments: xeroPayment.many(1),
      BankTransactions: xeroBankTransaction.many(1),
      ManualJournals: xeroManualJournal.many(1),
    },
    refreshToken: FIRST_REFRESH,
    ...overrides,
  };
}

const options = (mock: XeroMock, extra: Partial<XeroConnectorOptions> = {}): XeroConnectorOptions => ({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tenantId: XERO_TEST_TENANT,
  tokens: memoryTokenStore(FIRST_REFRESH),
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: XeroMock, extra: Partial<XeroConnectorOptions> = {}) => xeroConnector(options(mock, extra));
const reads = (mock: XeroMock) => mock.fetch.calls.filter((c) => c.method === "GET").map((c) => decodeURIComponent(c.url.replace(`${XERO_API_URL}/`, "")));
const refreshThen = (mock: XeroMock, answer: () => Response): typeof globalThis.fetch => async (input, init) =>
  String(input).startsWith(XERO_TOKEN_URL) ? mock.fetch(input as string, init) : answer();
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2ln"].join(".");

describe("Xero client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(xeroDocMock(organisation()));
    expect(() => xeroClient({ ...base, clientSecret: " " })).toThrow(new XeroConfigError("set XERO_CLIENT_ID and XERO_CLIENT_SECRET"));
    expect(() => xeroClient({ ...base, tenantId: "Demo Company" })).toThrow("XERO_TENANT_ID must be the organisation's tenant ID, a UUID");
    expect(() => xeroClient({ ...base, tenantId: ` ${XERO_TEST_TENANT.toUpperCase()} ` })).not.toThrow();
  });

  it("reads only its listed endpoints, with filters it built itself", async () => {
    const mock = xeroDocMock(organisation());
    const client = xeroClient(options(mock));
    await expect(client.get("Invoices/../Users" as never)).rejects.toThrow(new XeroConfigError("the Xero connector only reads its listed endpoints"));
    await expect(client.get("Users" as never)).rejects.toThrow(XeroConfigError);
    for (const where of ['Date>=DateTime(2020,1,1) OR Status=="DRAFT"', "Contact.Name==\"x\"", "Date>=DateTime(2020,1,1)&page=2"]) {
      await expect(client.get("Invoices", { where })).rejects.toThrow("the Xero connector only filters by date");
    }
    await expect(client.get("Invoices", { order: "Total DESC" })).rejects.toThrow("only orders by UpdatedDateUTC");
    await expect(client.get("Invoices", { page: 0 })).rejects.toThrow("page must be a whole number from 1");
    await expect(client.get("Invoices", { page: 1.5 })).rejects.toThrow(XeroConfigError);
    await expect(client.get("Invoices", { modifiedSince: "yesterday" })).rejects.toThrow("modifiedSince must be an ISO time in UTC");
    await expect(client.get("Invoices", { modifiedSince: "2026-01-19T00:00:00+05:00" })).rejects.toThrow(XeroConfigError);
    // Nothing above reached Xero.
    expect(mock.fetch.calls).toEqual([]);
    expect(XERO_ENDPOINTS).toEqual(["Accounts", "Contacts", "Invoices", "CreditNotes", "Payments", "BankTransactions", "ManualJournals"]);
  });

  it("gets with a bearer token and the tenant header, refreshing with Basic auth at Xero's identity service", async () => {
    const mock = xeroDocMock(organisation());
    const seen: { method: string; url: string; auth: string; tenant: string | null; since: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization") ?? "", tenant: request.headers.get("xero-tenant-id"), since: request.headers.get("if-modified-since") });
      return mock.fetch(request);
    };
    await xeroClient(options(mock, { fetch })).get("Invoices", { page: 1, modifiedSince: "2026-01-19T00:00:00.000Z" });
    expect(seen.map((s) => [s.method, s.url.split("?")[0]])).toEqual([
      ["POST", XERO_TOKEN_URL],
      ["GET", `${XERO_API_URL}/Invoices`],
    ]);
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(seen[1]!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect([seen[1]!.tenant, seen[1]!.since]).toEqual([XERO_TEST_TENANT, "2026-01-19T00:00:00"]);
    expect(new URL(seen[1]!.url).searchParams.get("pageSize")).toBe("1000");
  });

  it("stores each new refresh token before using it, since Xero retires the old one at once", async () => {
    const mock = xeroDocMock(organisation());
    const store = memoryTokenStore(FIRST_REFRESH);
    let t = 0;
    const client = xeroClient(options(mock, { tokens: store, clock: () => t }));
    await client.get("Accounts");
    expect(store.current).toBe("RT-TEST-1");
    // Within its 30 minutes the access token is reused.
    t = 27 * 60_000;
    await client.get("Accounts");
    expect(mock.refreshes).toBe(1);
    // Two minutes before it expires, it is renewed with the stored token.
    t = 28.5 * 60_000;
    await client.get("Accounts");
    expect([mock.refreshes, store.current]).toEqual([2, "RT-TEST-2"]);
    await expect(xeroClient(options(mock, { tokens: store })).get("Accounts")).resolves.toBeDefined();
    await expect(xeroClient(options(mock)).get("Accounts")).rejects.toThrow(/invalid_grant\); reconnect Xero/);
  });

  it("refreshes once for reads that need a token at the same time", async () => {
    const mock = xeroDocMock(organisation());
    const client = xeroClient(options(mock));
    await Promise.all([1, 2, 3].map(() => client.get("Accounts")));
    expect(mock.refreshes).toBe(1);
  });

  it("fails without using a token it couldn't store, and asks for a refresh token when there is none", async () => {
    const mock = xeroDocMock(organisation());
    const tokens: XeroTokenStore = { load: async () => FIRST_REFRESH, save: async () => Promise.reject(new Error("database down")) };
    await expect(xeroClient(options(mock, { tokens })).get("Accounts")).rejects.toThrow("database down");
    expect(mock.fetch.calls.filter((c) => c.method === "GET")).toEqual([]);
    const empty: XeroTokenStore = { load: async () => " ", save: async () => {} };
    await expect(xeroClient(options(mock, { tokens: empty })).get("Accounts")).rejects.toThrow("set XERO_REFRESH_TOKEN");
  });

  it("refuses a connection that can change data, after keeping the token Xero rotated", async () => {
    const mock = xeroDocMock(organisation({ scopes: ["offline_access", "accounting.invoices", "accounting.contacts.read"] }));
    const store = memoryTokenStore(FIRST_REFRESH);
    const error = await failure(xeroClient(options(mock, { tokens: store })).get("Invoices"));
    expect(error).toBeInstanceOf(XeroConfigError);
    expect(error.message).toBe(`the Xero connection can change data (accounting.invoices); reconnect it with only ${XERO_READ_SCOPES.join(" ")}`);
    // The rotated token is kept, so reconnecting isn't forced on top of fixing the scopes.
    expect(store.current).toBe("RT-TEST-1");
    expect(mock.fetch.calls.filter((c) => c.method === "GET")).toEqual([]);
    // The old broad scope counts as a write scope too.
    const broad = xeroDocMock(organisation({ scopes: ["accounting.transactions"] }));
    await expect(xeroClient(options(broad)).get("Invoices")).rejects.toThrow("(accounting.transactions)");
  });

  it("reads token scopes from the JWT, and tells read scopes from write ones", () => {
    expect(xeroTokenScopes(jwt({ scope: ["openid", "accounting.invoices.read"] }))).toEqual(["openid", "accounting.invoices.read"]);
    expect(xeroTokenScopes(jwt({ scope: "offline_access accounting.settings.read" }))).toEqual(["offline_access", "accounting.settings.read"]);
    expect(xeroTokenScopes(jwt({}))).toEqual([]);
    expect(xeroTokenScopes(jwt({ scope: [1, "profile"] }))).toEqual(["profile"]);
    expect([xeroTokenScopes("opaque"), xeroTokenScopes("a.%%%.c"), xeroTokenScopes("a..c")]).toEqual([null, null, null]);
    expect(xeroWriteScopes([...XERO_READ_SCOPES, "openid", "profile", "email", "accounting.reports.profitandloss.read", "payroll.employees.read"])).toEqual([]);
    expect(xeroWriteScopes(["accounting.settings", "accounting.attachments", "payroll.timesheets", "files", "accounting.read.write", "accounting.invoices.readx"])).toEqual([
      "accounting.settings",
      "accounting.attachments",
      "payroll.timesheets",
      "files",
      "accounting.read.write",
      "accounting.invoices.readx",
    ]);
    expect(XERO_MOCK_READ_SCOPES).toEqual([...XERO_READ_SCOPES]);
  });

  it("goes on with a token that isn't a readable JWT, since Xero still enforces its scopes", async () => {
    const mock = xeroDocMock(organisation());
    let refreshed = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith(XERO_TOKEN_URL)) return new Response(JSON.stringify({ Accounts: [] }), { status: 200 });
      refreshed = true;
      return new Response(JSON.stringify({ access_token: "opaque-token", refresh_token: "RT-TEST-9" }), { status: 200 });
    };
    await expect(xeroClient(options(mock, { fetch })).get("Accounts")).resolves.toEqual({ Accounts: [] });
    expect(refreshed).toBe(true);
  });

  it("refreshes once when an access token is revoked early, then gives up", async () => {
    const mock = xeroDocMock(organisation());
    const client = xeroClient(options(mock));
    await client.get("Accounts");
    mock.revokeAccessTokens();
    await client.get("Accounts");
    expect(mock.refreshes).toBe(2);
    const always401 = refreshThen(mock, () => new Response(JSON.stringify({ Title: "Unauthorized", Detail: "AuthenticationUnsuccessful" }), { status: 401 }));
    await expect(xeroClient(options(mock, { fetch: always401, tokens: memoryTokenStore(mock.refreshToken) })).get("Accounts")).rejects.toThrow(
      new XeroApiError("Xero answered HTTP 401: AuthenticationUnsuccessful", 401),
    );
  });

  it("waits out minute and concurrency limits, honouring Retry-After up to a minute", async () => {
    const waits: number[] = [];
    const mock = xeroDocMock(organisation({ rateLimits: [{ problem: "minute", retryAfter: 7 }, { problem: "concurrent" }, { problem: "minute", retryAfter: 3600 }] }));
    await xeroClient(options(mock, { sleep: async (ms) => void waits.push(ms) })).get("Accounts");
    expect(waits).toEqual([7000, 2000, 60_000]);
  });

  it("gives up after its retries, leaving the error to runSync", async () => {
    const mock = xeroDocMock(organisation());
    let limited = 0;
    const fetch = refreshThen(mock, () => {
      limited++;
      return new Response("{}", { status: 429, headers: { "retry-after": "nonsense" } });
    });
    const waits: number[] = [];
    const error = await failure(xeroClient(options(mock, { fetch, sleep: async (ms) => void waits.push(ms) })).get("Accounts"));
    expect([waits, limited]).toEqual([[1000, 2000, 4000], 4]);
    expect(error).toMatchObject({ name: "XeroApiError", status: 429, message: "Xero kept rate-limiting the sync" });
    const named = refreshThen(mock, () => new Response("{}", { status: 429, headers: { "x-rate-limit-problem": "AppMinute" } }));
    await expect(xeroClient(options(mock, { fetch: named, tokens: memoryTokenStore(mock.refreshToken), rateLimitRetries: 0 })).get("Accounts")).rejects.toMatchObject({
      message: "Xero kept rate-limiting the sync (appminute)",
      problem: "appminute",
    });
  });

  it("stops at the daily limit without waiting, so the next sync resumes from the checkpoint", async () => {
    const mock = xeroDocMock(organisation({ rateLimits: [{ problem: "day", retryAfter: 40_000 }] }));
    const waits: number[] = [];
    const error = await failure(xeroClient(options(mock, { sleep: async (ms) => void waits.push(ms) })).get("Accounts"));
    expect(waits).toEqual([]);
    expect(error).toMatchObject({ name: "XeroApiError", status: 429, problem: "day", message: "Xero's daily call limit for this organisation is used up; the next sync resumes from the checkpoint" });
  });

  it("reports Xero's errors cut short, with a hint for a lost connection, and never a token or secret", async () => {
    const mock = xeroDocMock(organisation());
    const long = refreshThen(mock, () => new Response(JSON.stringify({ ErrorNumber: 10, Type: "ValidationException", Message: "x".repeat(500) }), { status: 400 }));
    const cut = await failure(xeroClient(options(mock, { fetch: long, tokens: memoryTokenStore(mock.refreshToken) })).get("Accounts"));
    expect(cut.message.length).toBeLessThan(240);
    const other = xeroClient({ ...options(mock, { tokens: memoryTokenStore(mock.refreshToken) }), tenantId: "00000000-0000-4000-8000-0000000000ff" });
    const forbidden = await failure(other.get("Accounts"));
    expect(forbidden.message).toBe("Xero answered HTTP 403: AuthorizationUnsuccessful; check that the organisation is still connected to the KaratOS app");
    const bare = refreshThen(mock, () => new Response("not json", { status: 500 }));
    await expect(xeroClient(options(mock, { fetch: bare, tokens: memoryTokenStore(mock.refreshToken) })).get("Accounts")).rejects.toThrow(new XeroApiError("Xero answered HTTP 500", 500));
    const refused = await failure(xeroClient(options(mock)).get("Accounts"));
    for (const message of [cut.message, forbidden.message, refused.message]) {
      for (const secret of [CLIENT_ID, CLIENT_SECRET, FIRST_REFRESH, "RT-TEST-1", "AT-TEST"]) expect(message).not.toContain(secret);
    }
  });

  it("treats 304 Not Modified as nothing new, and refuses an answer that isn't JSON", async () => {
    const mock = xeroDocMock(organisation());
    const notModified = refreshThen(mock, () => new Response(null, { status: 304 }));
    await expect(xeroClient(options(mock, { fetch: notModified })).get("Accounts")).resolves.toEqual({});
    const text = refreshThen(mock, () => new Response("ok", { status: 200 }));
    await expect(xeroClient(options(mock, { fetch: text, tokens: memoryTokenStore(mock.refreshToken) })).get("Accounts")).rejects.toThrow("Xero did not answer with JSON");
  });

  it("routes the mock by exact host, so a look-alike identity host is refused", async () => {
    const mock = xeroDocMock(organisation());
    await expect(mock.fetch("https://identity.xero.com.example.test/connect/token", { method: "POST" })).rejects.toThrow(/not in the vendor's docs/);
  });
});

describe("Xero normalization", () => {
  const all = () => {
    const data = organisation();
    return XERO_ENDPOINTS.flatMap((e) => xeroPageEvents(e, data.records[e], RECEIVED));
  };

  it("keeps the books' money, dates and links, and nothing personal", () => {
    const events = all();
    const text = JSON.stringify(events.map((e) => e.payload));
    for (const personal of ["@", "555", "Test Street", "Testville", "00-0000000", "Synthetic reference", "Synthetic narration", "Synthetic line", "Synthetic payment", "Synthetic bank"]) {
      expect(text).not.toContain(personal);
    }
    const invoice = events.find((e) => e.type === "accounting.invoice_updated")!;
    expect(invoice).toMatchObject({
      idempotencyKey: `xero:invoice:${xeroGuid("1", 1)}:${Date.parse("2026-01-01T01:30:00Z")}`,
      occurredAt: "2026-01-01T01:30:00.000Z",
      payload: {
        invoiceId: `xero:invoice:${xeroGuid("1", 1)}`,
        number: "INV-TEST-1",
        customerId: `xero:contact:${xeroGuid("c", 1)}`,
        txnDate: "2026-01-02",
        dueDate: "2026-02-01",
        totalCents: 125_050,
        balanceCents: 125_050,
        currency: "USD",
        status: "authorised",
        lines: [{ amountCents: 125_050, item: "RING-TEST-14K", quantity: 1 }],
      },
    });
    expect(events.find((e) => e.type === "accounting.bill_updated")!.payload).toEqual({
      billId: `xero:bill:${xeroGuid("2", 1)}`,
      vendorId: `xero:contact:${xeroGuid("c", 51)}`,
      vendorName: "Test Supplier 1",
      number: "BILL-TEST-1",
      txnDate: "2026-01-02",
      dueDate: "2026-02-01",
      totalCents: 64_000,
      balanceCents: 64_000,
      currency: "USD",
      status: "authorised",
    });
    expect(events.find((e) => e.type === "accounting.credit_note_updated")!.payload).toMatchObject({ kind: "customer", customerId: `xero:contact:${xeroGuid("c", 1)}`, totalCents: 10_000, remainingCents: 10_000 });
    expect(events.find((e) => e.type === "accounting.payment_updated")!.payload).toEqual({
      paymentId: `xero:payment:${xeroGuid("4", 1)}`,
      customerId: `xero:contact:${xeroGuid("c", 1)}`,
      txnDate: "2026-01-02",
      totalCents: 50_000,
      currency: "USD",
      reconciled: false,
      status: "authorised",
      appliedTo: [{ type: "Invoice", id: `xero:invoice:${xeroGuid("1", 1)}`, amountCents: 50_000 }],
    });
    expect(events.find((e) => e.type === "accounting.bank_transaction_updated")!.payload).toEqual({
      bankTransactionId: `xero:bank_transaction:${xeroGuid("5", 1)}`,
      kind: "spend",
      bankAccountId: `xero:account:${xeroGuid("a", 1)}`,
      contactId: `xero:contact:${xeroGuid("c", 51)}`,
      txnDate: "2026-01-02",
      totalCents: 7_500,
      currency: "USD",
      reconciled: true,
      status: "authorised",
    });
    expect(events.find((e) => e.type === "accounting.journal_entry_updated")!.payload.lines).toEqual([
      { amountCents: 7_500, posting: "debit", accountCode: "429" },
      { amountCents: 7_500, posting: "credit", accountCode: "101" },
    ]);
    expect(events.find((e) => e.type === "accounting.account_updated")!.payload).toEqual({
      accountId: `xero:account:${xeroGuid("a", 1)}`,
      name: "Test Account 1",
      number: "101",
      classification: "ASSET",
      accountType: "BANK",
      active: true,
      currency: "USD",
    });
  });

  it("makes customers clienteling profiles and suppliers vendors, and a contact that is both gives both", () => {
    const both = xeroContact.one({ IsSupplier: true });
    const events = xeroEvents("Contacts", both, RECEIVED);
    expect(events.map((e) => [e.type, e.idempotencyKey.split(":").at(-1)])).toEqual([
      ["customer.profile_updated", "customer"],
      ["accounting.vendor_updated", "vendor"],
    ]);
    expect(events[0]!.payload).toEqual({ customerId: `xero:contact:${String(both.ContactID)}`, name: both.Name, marketingConsent: false });
    expect(events[1]!.payload).toEqual({ vendorId: `xero:contact:${String(both.ContactID)}`, name: both.Name, active: true });
    expect(xeroEvents("Contacts", { ...both, IsCustomer: false, IsSupplier: false }, RECEIVED)).toEqual([]);
    expect(xeroEvents("Contacts", { ...both, IsCustomer: "true", IsSupplier: false }, RECEIVED)).toEqual([]);
    expect(xeroEvents("Contacts", { ...both, Name: " ", IsSupplier: false, ContactStatus: "ARCHIVED" }, RECEIVED)[0]!.payload.name).toMatch(/^Xero customer /);
    expect(xeroEvents("Contacts", { ...both, Name: "", IsCustomer: false, ContactStatus: "ARCHIVED" }, RECEIVED)[0]!.payload).toMatchObject({ name: expect.stringMatching(/^Xero supplier /), active: false });
  });

  it("stores a new version when UpdatedDateUTC moves, a deletion once, and keeps voided records as updates", () => {
    const [invoice] = xeroInvoice.many(1);
    const first = xeroEvents("Invoices", invoice!, RECEIVED)[0]!;
    const later = xeroEvents("Invoices", { ...invoice!, UpdatedDateUTC: xeroMsDate("2026-01-05T00:00:00Z") }, RECEIVED)[0]!;
    expect(first.idempotencyKey).not.toBe(later.idempotencyKey);
    expect(xeroEvents("Invoices", { ...invoice!, Status: "VOIDED" }, RECEIVED)[0]).toMatchObject({ type: "accounting.invoice_updated", payload: { status: "voided" } });
    const id = String(invoice!.InvoiceID);
    expect(xeroEvents("Invoices", { ...invoice!, Status: "DELETED", UpdatedDateUTC: xeroMsDate("2026-01-19T12:00:00Z") }, RECEIVED)).toEqual([
      {
        id: `xero_invoice:${id}:deleted`,
        type: "accounting.record_deleted",
        occurredAt: "2026-01-19T12:00:00.000Z",
        receivedAt: RECEIVED,
        idempotencyKey: `xero:invoice:${id}:deleted`,
        payload: { recordId: `xero:invoice:${id}`, entity: "invoice" },
      },
    ]);
    const bill = xeroBill.one();
    expect(xeroEvents("Invoices", { ...bill, Status: "DELETED" }, RECEIVED)[0]!.payload).toEqual({ recordId: `xero:bill:${String(bill.InvoiceID)}`, entity: "bill" });
    for (const [endpoint, record] of [["Payments", xeroPayment.one()], ["BankTransactions", xeroBankTransaction.one()], ["ManualJournals", xeroManualJournal.one()], ["CreditNotes", xeroCreditNote.one()]] as const) {
      expect(xeroEvents(endpoint, { ...record, Status: "DELETED" }, RECEIVED)[0]!.type).toBe("accounting.record_deleted");
    }
    // Accounts and contacts are archived, not deleted; a DELETED status there is kept as an update.
    expect(xeroEvents("Accounts", { ...xeroAccount.one(), Status: "DELETED" }, RECEIVED)[0]!.type).toBe("accounting.account_updated");
  });

  it("lower-cases ids so one record has one key, and drops records with no usable id", () => {
    const account = xeroAccount.one({ AccountID: "ABCDEF00-0000-4000-8000-000000000001" });
    expect(xeroEvents("Accounts", account, RECEIVED)[0]!.payload.accountId).toBe("xero:account:abcdef00-0000-4000-8000-000000000001");
    expect(xeroEvents("Accounts", { Name: "No id" }, RECEIVED)).toEqual([]);
    expect(xeroEvents("Accounts", { AccountID: "../../Users" }, RECEIVED)).toEqual([]);
    expect(xeroEvents("Accounts", null as never, RECEIVED)).toEqual([]);
    expect(xeroPageEvents("Accounts", "not a list", RECEIVED)).toEqual([]);
  });

  it("reads Xero's /Date()/ times and ISO strings as UTC, and dead-letters anything else", () => {
    expect(xeroTime("/Date(1518685950940+0000)/")).toBe("2018-02-15T09:12:30.940Z");
    // The offset only says which zone Xero displayed; the milliseconds are already UTC.
    expect(xeroTime("/Date(1518685950940+1300)/")).toBe("2018-02-15T09:12:30.940Z");
    expect(xeroTime("/Date(1518685950940)/")).toBe("2018-02-15T09:12:30.940Z");
    expect(xeroTime("2026-01-19T12:00:00")).toBe("2026-01-19T12:00:00.000Z");
    expect(xeroTime("2026-01-19T12:00:00+13:00")).toBe("2026-01-18T23:00:00.000Z");
    for (const bad of ["soon", "/Date(abc)/", "2026-13-45T00:00:00", "", 5, undefined, "19/01/2026"]) expect(xeroTime(bad)).toBeUndefined();
    const timeless = xeroEvents("ManualJournals", { ManualJournalID: xeroGuid("6", 9) }, RECEIVED)[0]!;
    expect([timeless.occurredAt, timeless.idempotencyKey.endsWith(":0")]).toEqual([undefined, true]);
  });

  it("names unnamed accounts, and keeps amounts it can't read as null", () => {
    expect(xeroEvents("Accounts", { AccountID: xeroGuid("a", 9), Code: "999" }, RECEIVED)[0]!.payload.name).toBe("Account 999");
    expect(xeroEvents("Accounts", { AccountID: xeroGuid("a", 9) }, RECEIVED)[0]!.payload.name).toBe(`Account ${xeroGuid("a", 9)}`);
    expect([xeroCents(10.005), xeroCents(-0.1), xeroCents("5"), xeroCents(Number.NaN)]).toEqual([1001, -10, null, null]);
    expect(xeroEvents("Invoices", { InvoiceID: xeroGuid("1", 9), LineItems: "x", Contact: {} }, RECEIVED)[0]!.payload).toEqual({
      invoiceId: `xero:invoice:${xeroGuid("1", 9)}`,
      totalCents: null,
      balanceCents: null,
      lines: [],
    });
    expect(xeroEvents("ManualJournals", { ManualJournalID: xeroGuid("6", 9), JournalLines: [{ LineAmount: "x", AccountCode: "1" }] }, RECEIVED)[0]!.payload.lines).toEqual([{ amountCents: null, accountCode: "1" }]);
    const vendorCredit = xeroEvents("CreditNotes", { CreditNoteID: xeroGuid("3", 9), Type: "ACCPAYCREDIT", Contact: { ContactID: xeroGuid("c", 51) } }, RECEIVED)[0]!.payload;
    expect(vendorCredit).toMatchObject({ kind: "vendor", vendorId: `xero:contact:${xeroGuid("c", 51)}` });
    expect(vendorCredit).not.toHaveProperty("customerId");
    const billPayment = xeroEvents("Payments", { PaymentID: xeroGuid("4", 9), Amount: 5, Invoice: { InvoiceID: xeroGuid("2", 1), Type: "ACCPAY", Contact: { ContactID: xeroGuid("c", 51) } }, CurrencyCode: "NZD" }, RECEIVED)[0]!.payload;
    expect(billPayment).toMatchObject({ vendorId: `xero:contact:${xeroGuid("c", 51)}`, currency: "NZD", appliedTo: [{ type: "Bill", id: `xero:bill:${xeroGuid("2", 1)}`, amountCents: 500 }] });
    expect(xeroEvents("Payments", { PaymentID: xeroGuid("4", 8) }, RECEIVED)[0]!.payload).toMatchObject({ appliedTo: [], reconciled: false });
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(organisation())).not.toThrow();
  });
});

describe("Xero sync", () => {
  it("imports, replays, resumes and retries the mocked organisation", async () => {
    // 3 accounts; 4 contact events (an archived customer included, one contact neither); 2 invoices and one dead-lettered,
    // a deleted invoice and 2 bills; a credit note, payment, bank transaction and manual journal.
    const result = await checkConnectorSync({ makeConnector: () => connector(xeroDocMock(organisation())), expected: { ingested: 16, deadLettered: 1 } });
    expect(result.full.batches).toBe(7);
    expect(parseXeroCursor(result.full.cursor)).toMatchObject({ pass: "historical", step: "done", page: 1 });
  });

  it("reads each endpoint six years back, archived contacts included, paging 1000 at a time", async () => {
    const data = organisation();
    data.records.Invoices = xeroInvoice.many(1001);
    const mock = xeroDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.batches).toBe(8);
    const paged = (endpoint: string, page = 1) => `${endpoint}?page=${page}&pageSize=1000&where=Date>=DateTime(2020,1,20)&order=UpdatedDateUTC ASC`;
    expect(reads(mock).map((r) => r.replace(/\+/g, " "))).toEqual([
      "Accounts",
      "Contacts?page=1&pageSize=1000&order=UpdatedDateUTC ASC&includeArchived=true",
      paged("Invoices"),
      paged("Invoices", 2),
      paged("CreditNotes"),
      paged("Payments"),
      paged("BankTransactions"),
      paged("ManualJournals"),
    ]);
    expect(mock.fetch.calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual([XERO_TOKEN_URL]);
    expect(report.ingested).toBe(3 + 4 + 1001 + 4);
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(xeroDocMock(organisation())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 16, deadLettered: 1 });
    const types = memory.events.map((e) => e.type);
    expect(types.filter((t) => t === "customer.profile_updated")).toHaveLength(3);
    expect(new Set(types)).toEqual(
      new Set([
        "accounting.account_updated",
        "customer.profile_updated",
        "accounting.vendor_updated",
        "accounting.invoice_updated",
        "accounting.record_deleted",
        "accounting.bill_updated",
        "accounting.credit_note_updated",
        "accounting.payment_updated",
        "accounting.bank_transaction_updated",
        "accounting.journal_entry_updated",
      ]),
    );
  });

  it("leaves a finished import finished", async () => {
    const done: XeroCursor = { pass: "historical", step: "done", page: 1, since: "2020-01-20T00:00:00.000Z", nextFrom: RECEIVED };
    const mock = xeroDocMock(organisation());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect(batches).toEqual([]);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("reads changes since the last pass started, deletions included, and starts the next pass a little before this one", async () => {
    const data = organisation();
    data.records.Contacts![2]!.UpdatedDateUTC = xeroMsDate("2026-01-19T10:00:00Z");
    const mock = xeroDocMock(data);
    const previous: XeroCursor = { pass: "incremental", step: "done", page: 1, since: "2026-01-18T00:00:00.000Z", nextFrom: "2026-01-19T00:00:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "xero", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 2, duplicates: 0, batches: 7 });
    expect(reads(mock).map((r) => r.replace(/\+/g, " "))).toEqual([
      "Accounts",
      "Contacts?page=1&pageSize=1000&order=UpdatedDateUTC ASC&includeArchived=true",
      ...["Invoices", "CreditNotes", "Payments", "BankTransactions", "ManualJournals"].map((e) => `${e}?page=1&pageSize=1000&order=UpdatedDateUTC ASC`),
    ]);
    expect(memory.events.map((e) => e.type).sort()).toEqual(["accounting.record_deleted", "accounting.vendor_updated"]);
    expect(parseXeroCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", page: 1, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:55:00.000Z" });
  });

  it("sends If-Modified-Since from the checkpoint, and looks back 48 hours without one", async () => {
    const mock = xeroDocMock(organisation());
    const since: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      if (request.method === "GET") since.push(request.headers.get("if-modified-since"));
      return mock.fetch(request);
    };
    const first = await runSync({ connector: connector(mock, { fetch }), mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(since)).toEqual(new Set(["2026-01-18T00:00:00"]));
    expect(first.deadLettered).toBe(0);
  });

  it("resumes an interrupted incremental pass at the page it stopped on", async () => {
    const mock = xeroDocMock(organisation());
    const stopped: XeroCursor = { pass: "incremental", step: "Payments", page: 3, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:00:00.000Z" };
    const batches = [];
    for await (const b of connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) batches.push(b);
    expect(reads(mock)[0]).toContain("Payments?page=3&");
    expect(batches).toHaveLength(3);
    expect(parseXeroCursor(batches.at(-1)!.cursor)!.nextFrom).toBe("2026-01-19T23:00:00.000Z");
  });

  it("stops at Xero's daily limit with the checkpoint where it was, and carries on from there", async () => {
    const mock = xeroDocMock(organisation());
    const { memory, pipeline } = testPipeline();
    let calls = 0;
    let limited = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input as string, init);
      if (request.method === "GET" && ++calls >= 3 && limited) return new Response("{}", { status: 429, headers: { "x-rate-limit-problem": "day" } });
      return mock.fetch(request);
    };
    const stopped = await runSync({ connector: connector(mock, { fetch }), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: async () => {} }).catch((e: unknown) => e);
    expect(stopped).toMatchObject({ name: "XeroApiError", problem: "day" });
    expect(parseXeroCursor(await memory.getCheckpoint(TEST_ORG, "xero", "historical"))).toMatchObject({ step: "Invoices", page: 1 });
    limited = false;
    const resumed = await runSync({ connector: connector(mock, { fetch, tokens: memoryTokenStore(mock.refreshToken) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([resumed.batches, reads(mock)[2]]).toEqual([5, expect.stringContaining("Invoices?page=1&")]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: XeroCursor = { pass: "incremental", step: "Invoices", page: 1, since: "2026-01-19T00:00:00.000Z", nextFrom: "2026-01-19T23:00:00.000Z" };
    expect(parseXeroCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "Users" },
      { ...good, page: 0 },
      { ...good, page: 1.5 },
      { ...good, since: "2026-01-19) OR (1==1" },
      { ...good, nextFrom: "2026-13-45T00:00:00Z" },
      { ...good, since: "2026-01-19" },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      null,
    ]) {
      expect(() => parseXeroCursor(JSON.stringify(bad))).toThrow("Xero checkpoint is not in the expected shape");
    }
  });

  it("builds date filters only from its own dates", () => {
    expect(xeroDateFilter("2020-01-20T00:00:00.000Z")).toBe("Date>=DateTime(2020,1,20)");
    expect(xeroDateFilter("2019-12-05T00:00:00.000Z")).toBe("Date>=DateTime(2019,12,5)");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(xeroDocMock(organisation()));
    expect(c.writes).toBe(XERO_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => a.action)).toEqual(["create_invoice", "create_bill", "create_manual_journal"]);
  });
});

describe("Xero webhooks", () => {
  const KEY = ["webhook", "test", "0".repeat(40)].join("-");
  const OTHER = "00000000-0000-4000-8000-0000000000ff";
  const body = JSON.stringify({
    events: [
      { resourceUrl: "https://api.xero.com/api.xro/2.0/Invoices/x", resourceId: xeroGuid("1", 1).toUpperCase(), eventDateUtc: "2026-01-19T12:00:00.000", eventType: "UPDATE", eventCategory: "INVOICE", tenantId: XERO_TEST_TENANT, tenantType: "ORGANISATION" },
      { resourceId: xeroGuid("c", 1), eventDateUtc: "2026-01-19T12:01:00.000", eventType: "CREATE", eventCategory: "CONTACT", tenantId: XERO_TEST_TENANT.toUpperCase(), tenantType: "ORGANISATION" },
      { resourceId: xeroGuid("3", 1), eventType: "UPDATE", eventCategory: "CREDITNOTE", tenantId: XERO_TEST_TENANT, tenantType: "ORGANISATION" },
      { resourceId: xeroGuid("1", 2), eventType: "UPDATE", eventCategory: "INVOICE", tenantId: OTHER, tenantType: "ORGANISATION" },
      { resourceId: xeroGuid("1", 3), eventType: "DELETE", eventCategory: "INVOICE", tenantId: XERO_TEST_TENANT, tenantType: "ORGANISATION" },
      { resourceId: xeroGuid("1", 4), eventType: "UPDATE", eventCategory: "SUBSCRIPTION", tenantId: XERO_TEST_TENANT, tenantType: "APPLICATION" },
      { resourceId: "../1", eventType: "UPDATE", eventCategory: "INVOICE", tenantId: XERO_TEST_TENANT, tenantType: "ORGANISATION" },
      { resourceId: xeroGuid("1", 5), eventType: "UPDATE", eventCategory: "INVOICE", tenantId: XERO_TEST_TENANT, tenantType: "APPLICATION" },
    ],
    firstEventSequence: 1,
    lastEventSequence: 8,
    entropy: "SYNTHETICENTROPY",
  });

  it("accepts a correctly signed delivery and rejects tampered, unsigned, wrongly keyed or malformed ones", () => {
    const signature = hmacSha256(KEY, body, "base64");
    expect(verifyXeroWebhook(KEY, body, signature)).toEqual({ ok: true });
    expect(verifyXeroWebhook(KEY, Buffer.from(body), ` ${signature} `)).toEqual({ ok: true });
    expect(verifyXeroWebhook(KEY, tamper(body), signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyXeroWebhook(`${KEY}x`, body, signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyXeroWebhook(KEY, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyXeroWebhook("", body, signature)).toEqual({ ok: false, reason: "missing" });
    expect(verifyXeroWebhook(KEY, body, hmacSha256(KEY, body, "hex"))).toEqual({ ok: false, reason: "malformed" });
    expect(verifyXeroWebhook(KEY, body, "A".repeat(43))).toEqual({ ok: false, reason: "malformed" });
  });

  it("fails Xero's intent-to-receive check, which signs on purpose with the wrong key", () => {
    const itr = JSON.stringify({ events: [], firstEventSequence: 0, lastEventSequence: 0, entropy: "SYNTHETICENTROPY" });
    expect(verifyXeroWebhook(KEY, itr, hmacSha256(`${KEY}-wrong`, itr, "base64")).ok).toBe(false);
    expect(verifyXeroWebhook(KEY, itr, hmacSha256(KEY, itr, "base64")).ok).toBe(true);
  });

  it("lists this organisation's invoice, contact and credit note changes, and nothing else", () => {
    expect(xeroWebhookChanges(JSON.parse(body), XERO_TEST_TENANT)).toEqual([
      { category: "INVOICE", id: xeroGuid("1", 1), operation: "update", time: "2026-01-19T12:00:00.000" },
      { category: "CONTACT", id: xeroGuid("c", 1), operation: "create", time: "2026-01-19T12:01:00.000" },
      { category: "CREDITNOTE", id: xeroGuid("3", 1), operation: "update", time: undefined },
    ]);
    expect(xeroWebhookChanges([], XERO_TEST_TENANT)).toEqual([]);
    expect(xeroWebhookChanges(null, XERO_TEST_TENANT)).toEqual([]);
    expect(xeroWebhookChanges({ events: [null, { tenantId: 5 }] }, XERO_TEST_TENANT)).toEqual([]);
  });

  it("treats a replayed delivery as a prompt to sync, which stores nothing twice", async () => {
    const mock = xeroDocMock(organisation());
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const again = await runSync({ connector: connector(mock, { tokens: memoryTokenStore(mock.refreshToken) }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect(again.ingested).toBe(0);
  });
});
