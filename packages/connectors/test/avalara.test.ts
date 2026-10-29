import { describe, expect, it } from "vitest";
import { runSync } from "@karatos/core";
import {
  AVALARA_TEST_ACCOUNT,
  AVALARA_TEST_COMPANY,
  TEST_ORG,
  assertSynthetic,
  assertWritesRefused,
  avalaraCompany,
  avalaraDocMock,
  avalaraTransaction,
  checkConnectorSync,
  docMockFetch,
  testPipeline,
  type AvalaraMockData,
  type AvalaraMockTransaction,
} from "@karatos/connector-testkit";
import {
  AVALARA_CLIENT_HEADER,
  AVALARA_EVENT_TYPE,
  AVALARA_FIRST_LOOKBACK_DAYS,
  AVALARA_HOSTS,
  AVALARA_OVERLAP_MS,
  AVALARA_PAGE_SIZE,
  AVALARA_WRITES,
  AvalaraApiError,
  AvalaraConfigError,
  avalaraCents,
  avalaraClient,
  avalaraConnector,
  avalaraCustomerRef,
  avalaraDay,
  avalaraTime,
  avalaraTransactionEvent,
  formCustomerRefs,
  parseAvalaraCursor,
  type AvalaraCursor,
  type AvalaraOptions,
} from "../src/index.js";

const LICENSE = "x".repeat(16);
const KEY = "x".repeat(64);
const NOW = new Date("2026-10-28T12:00:00Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};
const CTX = { customerKey: KEY, accountId: AVALARA_TEST_ACCOUNT, companyCode: AVALARA_TEST_COMPANY, receivedAt: RECEIVED };

/** A transaction with fixed values, so building it twice gives the same thing. */
function tx(n: number, extra: Partial<AvalaraMockTransaction> = {}): AvalaraMockTransaction {
  avalaraTransaction.reset();
  for (let i = 1; i < n; i++) avalaraTransaction.one();
  return { ...avalaraTransaction.one(), ...extra };
}

function account(extra: Partial<AvalaraMockData> = {}): AvalaraMockData {
  avalaraCompany.reset();
  return {
    licenseKey: LICENSE,
    now: () => NOW,
    companies: [avalaraCompany.one(), avalaraCompany.one()],
    transactions: {
      [AVALARA_TEST_COMPANY]: [
        tx(1),
        tx(2, { status: "Cancelled" }),
        tx(3, { type: "ReturnInvoice", totalAmount: -500, totalTax: -44.38, totalTaxable: -500 }),
        // Dated six years ago: outside the import.
        tx(4, { date: "2020-01-15", taxDate: "2020-01-15" }),
        tx(5, { modifiedDate: "not a time" }),
      ],
      TESTSTORE2: [tx(6)],
    },
    ...extra,
  };
}

function connector(data: AvalaraMockData, options: Partial<AvalaraOptions> = {}) {
  const fetch = docMockFetch(avalaraDocMock(data));
  const c = avalaraConnector({ accountId: AVALARA_TEST_ACCOUNT, licenseKey: LICENSE, environment: "sandbox", customerKey: KEY, now: () => NOW, fetch, sleep: noSleep, ...options });
  return { c, fetch };
}

/** A fetch that answers each request from a list, recording what was sent. */
function scripted(responses: Response[]) {
  const sent: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const PING = { version: "26.10.0", authenticated: true, authenticatedAccountId: Number(AVALARA_TEST_ACCOUNT) };
const client = (fetch: typeof globalThis.fetch, extra: object = {}) => avalaraClient({ accountId: AVALARA_TEST_ACCOUNT, licenseKey: LICENSE, environment: "sandbox", fetch, sleep: noSleep, ...extra });
const filterOf = (url: string) => new URL(url).searchParams.get("$filter");
const txCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/transactions"));

describe("the AvaTax client", () => {
  it("stops on settings that aren't in the expected shape, without echoing them", () => {
    const base = { accountId: AVALARA_TEST_ACCOUNT, licenseKey: LICENSE, environment: "sandbox" as const };
    const cases: [object, string][] = [
      [{ accountId: "" }, "AVALARA_ACCOUNT_ID is missing or not an account number"],
      [{ accountId: "0123" }, "AVALARA_ACCOUNT_ID is missing or not an account number"],
      [{ accountId: "12a" }, "AVALARA_ACCOUNT_ID is missing or not an account number"],
      [{ licenseKey: "short" }, "AVALARA_LICENSE_KEY is missing or not in the expected shape"],
      [{ licenseKey: `${"x".repeat(16)}:` }, "AVALARA_LICENSE_KEY is missing or not in the expected shape"],
      [{ environment: "staging" }, "AVALARA_ENVIRONMENT must be sandbox or production"],
      [{ environment: undefined }, "AVALARA_ENVIRONMENT must be sandbox or production"],
    ];
    for (const [extra, message] of cases) {
      let error: unknown;
      try {
        avalaraClient({ ...base, ...extra } as never);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AvalaraConfigError);
      expect((error as Error).message).toBe(message);
    }
  });

  it("checks the connection with Basic credentials and the client header, on the host for the environment", async () => {
    for (const environment of ["sandbox", "production"] as const) {
      const { fetch, sent } = scripted([json(200, PING)]);
      await client(fetch, { environment }).ping();
      expect(sent[0]!.url.toString()).toBe(`${AVALARA_HOSTS[environment]}/api/v2/utilities/ping`);
      expect(sent[0]!.init?.method).toBe("GET");
      const headers = new Headers(sent[0]!.init?.headers);
      expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`${AVALARA_TEST_ACCOUNT}:${LICENSE}`).toString("base64")}`);
      expect(headers.get("x-avalara-client")).toBe(AVALARA_CLIENT_HEADER);
    }
  });

  it("stops when Ping says the credentials were turned down, or belong to another account", async () => {
    const a = scripted([json(200, { version: "26.10.0", authenticated: false })]);
    await expect(client(a.fetch).ping()).rejects.toMatchObject({ status: 401, message: expect.stringContaining("turned down the account ID and license key") });
    const b = scripted([json(200, { ...PING, authenticatedAccountId: 2000000002 })]);
    await expect(client(b.fetch).ping()).rejects.toThrow("AvaTax signed in to a different account than AVALARA_ACCOUNT_ID");
  });

  it("finds the configured company, or the default one", async () => {
    const a = scripted([json(200, { value: [{ id: 3001, companyCode: "TESTSTORE", isActive: true, isTest: true, taxpayerIdNumber: "00-0000000" }] })]);
    expect(await client(a.fetch).company("TESTSTORE")).toEqual({ id: 3001, companyCode: "TESTSTORE", isActive: true, isTest: true });
    expect(Object.fromEntries(a.sent[0]!.url.searchParams)).toEqual({ $filter: "companyCode eq 'TESTSTORE'", $top: "2" });
    const b = scripted([json(200, { value: [{ id: 3001, companyCode: "TESTSTORE", isDefault: true }] })]);
    expect((await client(b.fetch).company()).companyCode).toBe("TESTSTORE");
    expect(b.sent[0]!.url.searchParams.get("$filter")).toBe("isDefault eq true");
  });

  it("stops when the company isn't there, isn't the one asked for, or doesn't read", async () => {
    const cases: [unknown[], string | undefined, string][] = [
      [[], "TESTSTORE", "AvaTax has no company with the code in AVALARA_COMPANY_CODE"],
      [[{ id: 1, companyCode: "OTHER" }], "TESTSTORE", "AvaTax has no company with the code in AVALARA_COMPANY_CODE"],
      [[{ id: 1, companyCode: "A", isDefault: true }, { id: 2, companyCode: "B", isDefault: true }], undefined, "AvaTax has no single default company: set AVALARA_COMPANY_CODE"],
      [[{ id: "1", companyCode: "TESTSTORE" }], "TESTSTORE", "without an id and code that read"],
    ];
    for (const [value, code, message] of cases) {
      const { fetch } = scripted([json(200, { value })]);
      await expect(client(fetch).company(code)).rejects.toThrow(message);
    }
  });

  it("lists transactions by id, then by change time, with checked filters and the summary only", async () => {
    const { fetch, sent } = scripted([json(200, { value: [] }), json(200, { value: [] }), json(200, { value: [] })]);
    const c = client(fetch);
    await c.transactions("TESTSTORE", { fromDay: "2021-10-28", afterId: 42 });
    await c.transactions("TESTSTORE", { fromDay: "2021-10-28", modifiedFrom: "2026-10-01T00:00:00.000Z", skip: 0 });
    await c.transactions("TESTSTORE", { fromDay: "2021-10-28", modifiedFrom: "2026-10-01T00:00:00.000Z", skip: 3 });
    expect(sent.map((s) => s.url.pathname)).toEqual(Array(3).fill("/api/v2/companies/TESTSTORE/transactions"));
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({ $filter: "date ge '2021-10-28' and id gt 42", $orderBy: "id ASC", $include: "SummaryOnly", $top: String(AVALARA_PAGE_SIZE) });
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({ $filter: "date ge '2021-10-28' and modifiedDate ge '2026-10-01T00:00:00.000Z'", $orderBy: "modifiedDate ASC, id ASC", $include: "SummaryOnly", $top: "1000" });
    expect(sent[2]!.url.searchParams.get("$skip")).toBe("3");
  });

  it("sends nothing with a company code, day, id, time or skip that doesn't read", async () => {
    const { fetch, sent } = scripted([]);
    const c = client(fetch);
    const ok = { fromDay: "2021-10-28", afterId: 0 };
    await expect(c.company("TEST' or 1 eq 1")).rejects.toThrow("AVALARA_COMPANY_CODE is not in the expected shape");
    await expect(c.transactions("../accounts", ok)).rejects.toThrow("AVALARA_COMPANY_CODE is not in the expected shape");
    await expect(c.transactions("TEST STORE", ok)).rejects.toThrow("AVALARA_COMPANY_CODE is not in the expected shape");
    await expect(c.transactions("TESTSTORE", { ...ok, fromDay: "2021-10-28' or id gt 0" })).rejects.toThrow("YYYY-MM-DD day");
    await expect(c.transactions("TESTSTORE", { ...ok, afterId: -1 })).rejects.toThrow("after a whole id");
    await expect(c.transactions("TESTSTORE", { ...ok, afterId: 1.5 })).rejects.toThrow("after a whole id");
    await expect(c.transactions("TESTSTORE", { fromDay: "2021-10-28", modifiedFrom: "2026-10-01", skip: 0 })).rejects.toThrow("from a UTC time");
    await expect(c.transactions("TESTSTORE", { fromDay: "2021-10-28", modifiedFrom: "2026-10-01T00:00:00Z' or 1 eq 1", skip: 0 })).rejects.toThrow("from a UTC time");
    await expect(c.transactions("TESTSTORE", { fromDay: "2021-10-28", modifiedFrom: "2026-10-01T00:00:00Z", skip: -2 })).rejects.toThrow("skip must be a whole number");
    expect(sent).toEqual([]);
  });

  it("explains a turned-down key without showing it, and names AvaTax's error code", async () => {
    const a = scripted([json(401, { error: { code: "AuthenticationException", message: `bad key ${LICENSE}` } })]);
    const error = await client(a.fetch).company("TESTSTORE").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AvalaraApiError);
    expect(error).toMatchObject({ status: 401, code: "AuthenticationException" });
    expect((error as Error).message).not.toContain(LICENSE);
    const b = scripted([json(403, { error: { code: "PermissionRequired" } })]);
    await expect(client(b.fetch).company("TESTSTORE")).rejects.toMatchObject({ status: 403, message: "AvaTax's account isn't allowed to read companies (PermissionRequired)" });
    const c = scripted([json(404, { error: { code: "<b>not a code</b>" } })]);
    await expect(client(c.fetch).transactions("TESTSTORE", { fromDay: "2021-10-28", afterId: 0 })).rejects.toMatchObject({ status: 404, code: undefined, message: "AvaTax found no transactions" });
  });

  it("waits out a 429 or 503 for the seconds Retry-After gives, up to a minute, then leaves it to runSync", async () => {
    const waits: number[] = [];
    const busy = (status: number, after?: string) => json(status, {}, after ? { "Retry-After": after } : {});
    const a = scripted([busy(429, "5"), busy(503, "600"), busy(429), json(200, PING)]);
    await client(a.fetch, { sleep: async (ms: number) => void waits.push(ms) }).ping();
    expect(waits).toEqual([5_000, 60_000, 4_000]);
    const b = scripted([busy(429, "1"), busy(429, "1"), busy(429, "1"), busy(429, "1")]);
    await expect(client(b.fetch).ping()).rejects.toMatchObject({ status: 429, message: "AvaTax answered HTTP 429 for the connection check" });
    expect(b.sent).toHaveLength(4);
  });

  it("stops on other errors and on bodies that don't read", async () => {
    const cases: [Response, string][] = [
      [json(500, { error: { code: "ServerConfiguration" } }), "AvaTax answered HTTP 500 for transactions (ServerConfiguration)"],
      [new Response("<html>", { status: 200 }), "a body that isn't a JSON object"],
      [json(200, [1]), "a body that isn't a JSON object"],
      [json(200, { value: "nope" }), "without the value list"],
    ];
    for (const [response, message] of cases) {
      const { fetch } = scripted([response]);
      await expect(client(fetch).transactions("TESTSTORE", { fromDay: "2021-10-28", afterId: 0 })).rejects.toThrow(message);
    }
  });
});

describe("reading AvaTax values", () => {
  it("reads amounts as whole cents", () => {
    for (const [value, cents] of [[0.29, 29], [19.99, 1999], [1.005, 101], [-44.38, -4438], [0, 0], [1234567.89, 123456789]] as const) expect(avalaraCents(value), String(value)).toBe(cents);
    for (const bad of ["10", null, Number.NaN, Number.POSITIVE_INFINITY, 1e14]) expect(avalaraCents(bad)).toBeNull();
  });

  it("reads days and times as AvaTax writes them", () => {
    expect(avalaraDay("2026-06-02")).toBe("2026-06-02");
    expect(avalaraDay("2026-06-02T00:00:00")).toBe("2026-06-02");
    expect(avalaraDay("2026-06-02T00:00:00Z")).toBe("2026-06-02");
    for (const bad of ["2026-02-30", "2026-06-02T10:00:00", "06/02/2026", 20260602]) expect(avalaraDay(bad)).toBeNull();
    expect(avalaraTime("2026-06-02T10:30:00.1234567Z")).toBe("2026-06-02T10:30:00.123Z");
    expect(avalaraTime("2026-06-02T10:30:00.5")).toBe("2026-06-02T10:30:00.500Z");
    expect(avalaraTime("2026-06-02T10:30:00Z")).toBe("2026-06-02T10:30:00.000Z");
    for (const bad of ["2026-06-02T10:30:00+02:00", "2026-13-02T10:30:00Z", "2026-06-02", "soon"]) expect(avalaraTime(bad)).toBeNull();
  });

  it("makes the same customer reference for a code in one company, and a different one elsewhere", () => {
    const ref = avalaraCustomerRef(KEY, AVALARA_TEST_ACCOUNT, "TESTSTORE", "CUST-TEST-1");
    expect(ref).toMatch(/^avalara_customer:[0-9a-f]{32}$/);
    expect(avalaraCustomerRef(KEY, AVALARA_TEST_ACCOUNT, "TESTSTORE", " CUST-TEST-1 ")).toBe(ref);
    expect(avalaraCustomerRef(KEY, AVALARA_TEST_ACCOUNT, "TESTSTORE2", "CUST-TEST-1")).not.toBe(ref);
    expect(avalaraCustomerRef("y".repeat(64), AVALARA_TEST_ACCOUNT, "TESTSTORE", "CUST-TEST-1")).not.toBe(ref);
    for (const bad of [undefined, "", "  ", 7, "x".repeat(51)]) expect(avalaraCustomerRef(KEY, AVALARA_TEST_ACCOUNT, "TESTSTORE", bad)).toBeUndefined();
  });
});

describe("AvaTax transactions", () => {
  it("turns a sale into a tax event by jurisdiction, with no personal details", () => {
    const t = tx(1, { entityUseCode: "G", exemptNo: "EXEMPT-TEST-1", businessIdentificationNo: "XX-TEST-1" });
    const read = avalaraTransactionEvent(t, CTX);
    expect(read.ok).toBe(true);
    const e = read.event;
    expect(e.type).toBe(AVALARA_EVENT_TYPE);
    expect(e.occurredAt).toBe("2026-06-02T00:30:00.123Z");
    expect(e.idempotencyKey).toMatch(/^avalara:transaction:500000001:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(e.payload).toEqual({
      system: "Avalara AvaTax",
      transactionId: 500000001,
      companyCode: AVALARA_TEST_COMPANY,
      documentCode: "TEST-ORDER-1001",
      kind: "sale",
      documentType: "SalesInvoice",
      status: "Committed",
      day: "2026-06-02",
      taxDay: "2026-06-02",
      currency: "USD",
      totalAmountCents: 101000,
      totalTaxableCents: 101000,
      totalExemptCents: 0,
      totalTaxCents: 8964,
      totalTaxCalculatedCents: 8964,
      region: "NY",
      country: "US",
      locationCode: "STORE-1",
      exemptReason: "G",
      hasExemptionCertificate: true,
      taxOverride: undefined,
      adjustmentReason: undefined,
      version: 1,
      reconciled: false,
      locked: false,
      customerRef: avalaraCustomerRef(KEY, AVALARA_TEST_ACCOUNT, AVALARA_TEST_COMPANY, "CUST-TEST-1"),
      customerRefs: formCustomerRefs(KEY, { email: "customer1@example.test" }),
      jurisdictions: [
        { country: "US", region: "NY", type: "State", code: "36", name: "NEW YORK", taxType: "Sales", taxName: "NY STATE TAX", rate: 0.04, taxableCents: 101000, taxCents: 4040, taxCalculatedCents: 4040, nonTaxableCents: 0, exemptCents: 0 },
        { country: "US", region: "NY", type: "City", code: "51000", name: "NEW YORK CITY", taxType: "Sales", taxName: "NY CITY TAX", rate: 0.045, taxableCents: 101000, taxCents: 4545, taxCalculatedCents: 4545, nonTaxableCents: 0, exemptCents: 0 },
        { country: "US", region: "NY", type: "Special", code: "51000", name: "METROPOLITAN COMMUTER TRANSPORTATION DISTRICT", taxType: "Sales", taxName: "NY SPECIAL TAX", rate: 0.00375, taxableCents: 101000, taxCents: 379, taxCalculatedCents: 379, nonTaxableCents: 0, exemptCents: 0 },
      ],
      modifiedAt: "2026-06-02T00:30:00.123Z",
    });
    const stored = JSON.stringify(e);
    for (const secret of ["customer1@example.test", "Customer 1", "CUST-TEST-1", "EXEMPT-TEST", "XX-TEST", "PO-TEST", "TEST-REP", "Test Street", "10001", "RING-TEST", "Engagement ring for", "00-0000000"]) {
      expect(stored, secret).not.toContain(secret);
    }
    assertSynthetic(e);
  });

  it("keeps what each kind of document is, and a return's negative amounts", () => {
    const kinds: [string, string][] = [
      ["SalesOrder", "sale"],
      ["ReturnInvoice", "return"],
      ["PurchaseInvoice", "purchase"],
      ["InventoryTransferOutboundInvoice", "transfer"],
      ["ReverseChargeInvoice", "reverse_charge"],
      ["CustomsInvoice", "customs"],
    ];
    for (const [type, kind] of kinds) expect(avalaraTransactionEvent(tx(1, { type }), CTX).event.payload.kind, type).toBe(kind);
    const ret = avalaraTransactionEvent(tx(3, { type: "ReturnInvoice", totalAmount: -500, totalTax: -44.38 }), CTX).event.payload;
    expect(ret).toMatchObject({ kind: "return", totalAmountCents: -50000, totalTaxCents: -4438 });
  });

  it("keeps overrides and adjustments, and leaves out the defaults", () => {
    const e = avalaraTransactionEvent(tx(1, { taxOverrideType: "TaxDate", adjustmentReason: "PriceAdjusted", adjustmentDescription: "Customer 1 asked for a discount", status: "Adjusted", version: 2 }), CTX).event;
    expect(e.payload).toMatchObject({ taxOverride: "TaxDate", adjustmentReason: "PriceAdjusted", status: "Adjusted", version: 2 });
    expect(JSON.stringify(e)).not.toContain("asked for a discount");
    expect(avalaraTransactionEvent(tx(1), CTX).event.payload).toMatchObject({ taxOverride: undefined, adjustmentReason: undefined, exemptReason: undefined, hasExemptionCertificate: false });
  });

  it("keeps only jurisdiction values in the shapes AvaTax documents", () => {
    const odd = { ...tx(1).summary[0]!, jurisType: "Galaxy", jurisName: "<script>x</script>", rate: 4, region: "new york", taxable: "1010" };
    const e = avalaraTransactionEvent(tx(1, { summary: [odd as never, "nope" as never] }), CTX).event;
    expect(e.payload.jurisdictions).toEqual([{ country: "US", region: undefined, type: "Other", code: "36", name: undefined, taxType: "Sales", taxName: "NY STATE TAX", rate: null, taxableCents: null, taxCents: 4040, taxCalculatedCents: 4040, nonTaxableCents: 0, exemptCents: 0 }]);
    const many = avalaraTransactionEvent(tx(1, { summary: Array(150).fill(tx(1).summary[0]) }), CTX).event;
    expect(many.payload.jurisdictions).toHaveLength(100);
  });

  it("links a transaction without an email or customer code to no one", () => {
    const e = avalaraTransactionEvent(tx(1, { email: null, customerCode: "" }), CTX).event;
    expect(e.payload).toMatchObject({ customerRef: undefined, customerRefs: [] });
  });

  it("is a duplicate when read again unchanged and a new event when it changes", () => {
    const a = avalaraTransactionEvent(tx(1), CTX).event;
    expect(avalaraTransactionEvent(tx(1), { ...CTX, receivedAt: "2026-10-29T00:00:00.000Z" }).event.idempotencyKey).toBe(a.idempotencyKey);
    expect(avalaraTransactionEvent(tx(1, { status: "Cancelled", modifiedDate: "2026-06-03T10:00:00Z" }), CTX).event.idempotencyKey).not.toBe(a.idempotencyKey);
    // Changes to what isn't kept, such as the description, don't make a new event.
    expect(avalaraTransactionEvent(tx(1, { description: "Something else" }), CTX).event.idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters what doesn't read, listing why and keeping nothing personal", () => {
    const cases: [unknown, string][] = [
      ["nope", "transaction is not an object"],
      [tx(1, { id: 0 }), "transaction has no id that reads"],
      [tx(1, { id: "500000001" as never }), "transaction has no id that reads"],
      [tx(1, { date: "yesterday" }), "transaction has no day that reads"],
      [tx(1, { modifiedDate: "" }), "transaction has no change time that reads"],
      [tx(1, { type: "Invoice" }), "transaction type is not one AvaTax documents"],
      [tx(1, { status: "Deleted" }), "transaction status is not one AvaTax documents"],
      [tx(1, { totalTax: "8.96" as never }), "transaction has no total tax that reads"],
    ];
    for (const [raw, problem] of cases) {
      const read = avalaraTransactionEvent(raw, CTX);
      expect(read.ok, problem).toBe(false);
      expect(read.event.occurredAt).toBeUndefined();
      expect(read.event.idempotencyKey).toMatch(/^avalara:unreadable_transaction:[0-9a-f]{12}$/);
      expect(read.event.payload.problems).toContain(problem);
      expect(Object.keys(read.event.payload).sort()).toEqual(["problems", "system", "transactionId"]);
      expect(JSON.stringify(read.event)).not.toMatch(/customer1|CUST-TEST|Customer 1/);
    }
  });
});

describe("the Avalara connector", () => {
  it("imports, replays, resumes and retries the mocked account", async () => {
    // Four transactions in the window, one of them unreadable; the one from 2020 is outside it.
    const big = account();
    big.transactions[AVALARA_TEST_COMPANY] = Array.from({ length: 1003 }, (_, i) => tx(i + 1));
    const result = await checkConnectorSync({ makeConnector: () => connector({ ...big, transactions: structuredClone(big.transactions) }).c, expected: { ingested: 1003 } });
    expect(result.full.batches).toBe(2);
    const small = await checkConnectorSync({ makeConnector: () => connector(account()).c, expected: { ingested: 3, deadLettered: 1 } });
    expect(small.full.batches).toBe(1);
  });

  it("checks the connection, finds the company and reads five years by id", async () => {
    const { c, fetch } = connector(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 3, deadLettered: 1 });
    expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual(["/api/v2/utilities/ping", "/api/v2/companies", "/api/v2/companies/TESTSTORE/transactions"]);
    expect(filterOf(fetch.calls[1]!.url)).toBe("isDefault eq true");
    expect(filterOf(fetch.calls[2]!.url)).toBe("date ge '2021-10-28' and id gt 0");
    expect(memory.events.map((e) => e.payload.transactionId)).toEqual([500000001, 500000002, 500000003]);
    expect(memory.events.map((e) => e.payload.status)).toEqual(["Committed", "Cancelled", "Committed"]);
    // Customer references are keyed hashes, whose hex can look like a phone number to the check; everything else must be synthetic.
    assertSynthetic(memory.events.map((e) => ({ ...e, payload: { ...e.payload, customerRef: undefined, customerRefs: undefined } })));
    expect(JSON.stringify(memory.events)).not.toMatch(/@example\.test|CUST-TEST|Test Street/);
  });

  it("reads the configured company rather than the default one", async () => {
    const { c, fetch } = connector(account(), { companyCode: "TESTSTORE2" });
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(filterOf(fetch.calls[1]!.url)).toBe("companyCode eq 'TESTSTORE2'");
    expect(new URL(fetch.calls[2]!.url).pathname).toBe("/api/v2/companies/TESTSTORE2/transactions");
    expect(memory.events.map((e) => e.payload.companyCode)).toEqual(["TESTSTORE2"]);
  });

  it("honors a shorter history window", async () => {
    const { c, fetch } = connector(account(), { historyYears: 1 });
    await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(filterOf(txCalls(fetch.calls)[0]!.url)).toBe("date ge '2025-10-28' and id gt 0");
  });

  it("pages by the last id read and records it, then leaves a finished import finished", async () => {
    const data = account();
    data.transactions[AVALARA_TEST_COMPANY] = Array.from({ length: 2001 }, (_, i) => tx(i + 1));
    const { c, fetch } = connector(data);
    const cursors: AvalaraCursor[] = [];
    for await (const batch of c.historicalImport({ organizationId: TEST_ORG, cursor: null })) cursors.push(JSON.parse(batch.cursor!));
    expect(cursors).toEqual([{ afterId: 500001000, done: false }, { afterId: 500002000, done: false }, { afterId: 500002001, done: true }]);
    expect(txCalls(fetch.calls).map((call) => filterOf(call.url))).toEqual(["date ge '2021-10-28' and id gt 0", "date ge '2021-10-28' and id gt 500001000", "date ge '2021-10-28' and id gt 500002000"]);
    const again = connector(data);
    const batches = [];
    for await (const batch of again.c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(cursors.at(-1)) })) batches.push(batch);
    expect(batches).toEqual([]);
    expect(again.fetch.calls).toEqual([]);
  });

  it("resumes an import after the last id it read", async () => {
    const { c, fetch } = connector(account());
    const ids = [];
    for await (const batch of c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ afterId: 500000001, done: false }) })) ids.push(...batch.events.map((e) => (e as { payload: { transactionId: number } }).payload.transactionId));
    expect(filterOf(txCalls(fetch.calls)[0]!.url)).toBe("date ge '2021-10-28' and id gt 500000001");
    // The last is the unreadable one, dead-lettered by its id.
    expect(ids).toEqual([500000002, 500000003, 500000005]);
  });

  it("stops rather than loop on a full page with no id after the last one read", async () => {
    const page = Array.from({ length: AVALARA_PAGE_SIZE }, () => ({ id: 5 }));
    const { fetch } = scripted([json(200, PING), json(200, { value: [{ id: 3001, companyCode: "TESTSTORE", isDefault: true }] }), json(200, { value: page })]);
    const { c } = connector(account(), { fetch });
    const run = c.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ afterId: 10, done: false }) });
    await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow("no id after the last one read");
  });

  it("reads changes since the last pass started, less the overlap, and starts the next pass there", async () => {
    const data = account();
    const { memory, pipeline } = testPipeline();
    const first = connector(data);
    const one = await runSync({ connector: first.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // With no checkpoint the first pass looks back seven days: none of the fixtures changed that recently.
    expect(one).toMatchObject({ ingested: 0 });
    expect(filterOf(txCalls(first.fetch.calls)[0]!.url)).toBe(`date ge '2021-10-28' and modifiedDate ge '${new Date(NOW.getTime() - AVALARA_FIRST_LOOKBACK_DAYS * 86_400_000).toISOString()}'`);
    const saved = JSON.parse((await memory.getCheckpoint(TEST_ORG, "avalara", "incremental"))!) as { modifiedFrom: string; skip: number; nextFrom: string | null };
    expect(saved).toEqual({ modifiedFrom: new Date(NOW.getTime() - AVALARA_OVERLAP_MS).toISOString(), skip: 0, nextFrom: null });

    // Voided after the last pass started: the next pass reads it.
    const voided = data.transactions[AVALARA_TEST_COMPANY]![0]!;
    Object.assign(voided, { status: "Cancelled", modifiedDate: "2026-10-28T11:58:00.0000000Z" });
    const later = new Date("2026-10-29T12:00:00Z");
    const second = connector(data, { now: () => later });
    const two = await runSync({ connector: second.c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(two.ingested).toBe(1);
    expect(memory.events.at(-1)!.payload).toMatchObject({ transactionId: 500000001, status: "Cancelled" });
    expect(filterOf(txCalls(second.fetch.calls)[0]!.url)).toBe(`date ge '2021-10-29' and modifiedDate ge '${saved.modifiedFrom}'`);
  });

  it("resumes a pass part way from the change time it read to, without skipping or repeating one", async () => {
    const data = account();
    // 1,002 transactions changed at the same moment, then two later ones.
    const same = "2026-10-27T09:00:00.0000000Z";
    data.transactions[AVALARA_TEST_COMPANY] = [
      ...Array.from({ length: 1002 }, (_, i) => tx(i + 1, { modifiedDate: same })),
      tx(1003, { modifiedDate: "2026-10-27T10:00:00Z" }),
      tx(1004, { modifiedDate: "2026-10-27T11:00:00Z" }),
    ];
    const { c, fetch } = connector(data);
    const cursors: AvalaraCursor[] = [];
    const ids: number[] = [];
    for await (const batch of c.incrementalSync({ organizationId: TEST_ORG, cursor: null })) {
      cursors.push(JSON.parse(batch.cursor!));
      ids.push(...batch.events.map((e) => (e as { payload: { transactionId: number } }).payload.transactionId));
    }
    const nextFrom = new Date(NOW.getTime() - AVALARA_OVERLAP_MS).toISOString();
    expect(cursors).toEqual([{ modifiedFrom: "2026-10-27T09:00:00.000Z", skip: 1000, nextFrom }, { modifiedFrom: nextFrom, skip: 0, nextFrom: null }]);
    expect(new URL(txCalls(fetch.calls)[1]!.url).searchParams.get("$skip")).toBe("1000");
    expect(ids).toHaveLength(1004);
    expect(new Set(ids).size).toBe(1004);

    // Resumed from the first checkpoint, the pass reads only what came after it.
    // Resumed a day later, it still hands the next pass the start time it promised, so nothing changed in between is missed.
    const resumed = connector(data, { now: () => new Date(NOW.getTime() + 86_400_000) });
    const rest: number[] = [];
    let last: AvalaraCursor | undefined;
    for await (const batch of resumed.c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(cursors[0]) })) {
      rest.push(...batch.events.map((e) => (e as { payload: { transactionId: number } }).payload.transactionId));
      last = JSON.parse(batch.cursor!);
    }
    expect(rest).toEqual([500001001, 500001002, 500001003, 500001004]);
    expect(last).toEqual({ modifiedFrom: nextFrom, skip: 0, nextFrom: null });
  });

  it("retries a rate-limited sync from its checkpoint", async () => {
    const { c } = connector(account({ rateLimited: 2 }), { retries: 1 });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep });
    expect(report).toMatchObject({ ingested: 3, deadLettered: 1 });
  });

  it("stops the sync with what to check when the key is turned down", async () => {
    const { c, fetch } = connector({ ...account(), licenseKey: "y".repeat(16) });
    const error = await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).not.toContain(LICENSE);
    expect(fetch.calls).toHaveLength(1);
  });

  it("only sends the three documented reads", async () => {
    const { c, fetch } = connector(account());
    await runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    await runSync({ connector: c, mode: "incremental", ...testPipeline(), organizationId: TEST_ORG });
    expect(new Set(fetch.calls.map((call) => call.method))).toEqual(new Set(["GET"]));
    for (const call of fetch.calls) expect(new URL(call.url).pathname).toMatch(/^\/api\/v2\/(utilities\/ping|companies|companies\/[A-Za-z0-9_.-]+\/transactions)$/);
  });

  it("declares its writes and a read-only gate stops every one", async () => {
    const { c } = connector(account());
    expect(c.writes).toBe(AVALARA_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((entry) => entry.action)).toEqual(["create_transaction", "commit_transaction", "void_transaction", "adjust_transaction", "refund_transaction"]);
    expect(audit.every((entry) => entry.outcome === "refused")).toBe(true);
    expect("handleWebhook" in c).toBe(false);
  });

  it("checks its settings before reading anything", () => {
    const base = { accountId: AVALARA_TEST_ACCOUNT, licenseKey: LICENSE, environment: "sandbox" as const, customerKey: KEY };
    expect(() => avalaraConnector({ ...base, customerKey: "short" })).toThrow("CUSTOMER_REF_KEY must be at least");
    expect(() => avalaraConnector({ ...base, licenseKey: "bad" })).toThrow(AvalaraConfigError);
    for (const n of [0, -1, 1.5]) expect(() => avalaraConnector({ ...base, historyYears: n })).toThrow("historyYears must be a positive whole number");
  });

  it("reads a checkpoint only in the shape it writes for that sync", () => {
    expect(parseAvalaraCursor(null, "historical")).toBeNull();
    expect(parseAvalaraCursor(JSON.stringify({ afterId: 5, done: false }), "historical")).toEqual({ afterId: 5, done: false });
    const later = { modifiedFrom: "2026-10-01T00:00:00.000Z", skip: 2, nextFrom: null };
    expect(parseAvalaraCursor(JSON.stringify(later), "incremental")).toEqual(later);
    const bad: [string, "historical" | "incremental"][] = [
      ["not json", "historical"],
      ["[]", "historical"],
      [JSON.stringify(later), "historical"],
      [JSON.stringify({ afterId: 5, done: false }), "incremental"],
      [JSON.stringify({ afterId: -1, done: false }), "historical"],
      [JSON.stringify({ afterId: "5", done: false }), "historical"],
      [JSON.stringify({ afterId: 5 }), "historical"],
      [JSON.stringify({ ...later, modifiedFrom: "2026-10-01" }), "incremental"],
      [JSON.stringify({ ...later, modifiedFrom: "2026-10-01T00:00:00Z' or 1 eq 1" }), "incremental"],
      [JSON.stringify({ ...later, skip: 1.5 }), "incremental"],
      [JSON.stringify({ ...later, nextFrom: "later" }), "incremental"],
    ];
    for (const [raw, mode] of bad) expect(() => parseAvalaraCursor(raw, mode), raw).toThrow("Avalara checkpoint is not in the expected shape");
  });
});

describe("the AvaTax mock", () => {
  it("answers as the docs describe", async () => {
    const fetch = docMockFetch(avalaraDocMock(account()));
    const headers = { authorization: `Basic ${Buffer.from(`${AVALARA_TEST_ACCOUNT}:${LICENSE}`).toString("base64")}` };
    const base = "https://sandbox-rest.avatax.com/api/v2";
    expect((await fetch(`${base}/companies`, { headers: { authorization: "Basic eA==" } })).status).toBe(401);
    expect(await (await fetch(`${base}/utilities/ping`, { headers: { authorization: "Basic eA==" } })).json()).toMatchObject({ authenticated: false });
    expect((await fetch(`${base}/companies?$filter=${encodeURIComponent("name contains 'x'")}`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/companies/NOPE/transactions`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/companies/TESTSTORE/transactions?$include=Everything`, { headers })).status).toBe(400);
    // With no date filter, AvaTax looks only at the last 30 days.
    const recent = (await (await fetch(`${base}/companies/TESTSTORE/transactions`, { headers })).json()) as { value: unknown[] };
    expect(recent.value).toEqual([]);
    const summary = (await (await fetch(`${base}/companies/TESTSTORE/transactions?$filter=${encodeURIComponent("date ge '2021-01-01'")}&$include=SummaryOnly`, { headers })).json()) as { value: Record<string, unknown>[] };
    expect(summary.value[0]).not.toHaveProperty("lines");
    expect(summary.value[0]).not.toHaveProperty("addresses");
    expect(summary.value[0]!.summary).toHaveLength(3);
    await expect(fetch(`${base}/companies/TESTSTORE/transactions`, { method: "POST", headers })).rejects.toThrow("is not in the vendor's docs");
  });
});
