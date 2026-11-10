import { describe, expect, it } from "vitest";
import type { SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, billBill, billDocMock, billPayment, billVendor, checkConnectorSync, type BillMockData } from "@karatos/connector-testkit";
import {
  BILL_HOSTS,
  BILL_MAX_PAGES,
  BILL_OVERLAP_MS,
  BILL_PAGE_SIZE,
  BILL_WRITES,
  BillApiError,
  BillConfigError,
  billCents,
  billClient,
  billComConnector,
  billDay,
  billErrorCode,
  billEvent,
  billId,
  billTime,
  parseBillCursor,
  type BillClient,
  type BillCursor,
} from "../src/index.js";

// Shaped like a BILL client id and secret, assembled so no scanner mistakes them for real ones.
const ID = ["test", "0".repeat(20)].join("");
const SECRET = ["test", "1".repeat(40)].join("");
const NOW = new Date("2026-11-10T12:00:00.000Z");
const RECEIVED = NOW.toISOString();
const noSleep = async () => {};
const VENDORS = billVendor.many(2);
const BILLS = billBill.many(3);
const PAYMENTS = billPayment.many(1);
const VENDOR = VENDORS[0]!;
const BILL = BILLS[0]!;
const PAYMENT = PAYMENTS[0]!;
const LONG = billBill.many(230).map((b, i) => ({ ...b, updatedTime: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }));

function account(over: Partial<BillMockData> = {}) {
  return billDocMock({ clientId: ID, clientSecret: SECRET, vendors: VENDORS, bills: BILLS, payments: PAYMENTS, ...over });
}

function connector(mock = account(), over: Record<string, unknown> = {}) {
  return billComConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: () => NOW, ...over });
}

async function batches(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const events = (out: SourceBatch[]) => out.flatMap((b) => b.events as { type: string; occurredAt?: string; idempotencyKey: string; payload: Record<string, unknown> }[]);
const cursorOf = (b: SourceBatch) => JSON.parse(b.cursor!) as BillCursor;

/** A fetch that answers from a list of responses, recording what was asked. */
function scripted(responses: (() => Response)[]) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const token = (expires: unknown = 3600) => json(200, { access_token: "testtoken000000000001", expires_in: expires, token_type: "Bearer" });
const page = (results: unknown[], nextPage?: string) => json(200, { results, ...(nextPage ? { nextPage } : {}) });
const bdc = (status: number, code: string) => json(status, [{ code, severity: "ERROR", category: "DOWNSTREAM", message: "x" }]);

describe("the BILL client", () => {
  it("signs in with the form BILL documents and lists with a bearer token only, 100 at a time, oldest change first", async () => {
    const { fetch, sent } = scripted([token(), page([{ id: "x" }, 3, null, [{ id: "y" }]], "next-1")]);
    const client = billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep, now: () => NOW });
    expect(await client.list("bills", { since: "2026-01-01T00:00:00.000Z" })).toEqual({ results: [{ id: "x" }], nextPage: "next-1" });
    expect(sent[0]!.url).toBe("https://auth.bill.com/authx/token");
    expect(sent[0]!.init?.method).toBe("POST");
    expect(new Headers(sent[0]!.init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(sent[0]!.init?.body)))).toEqual({ grant_type: "client_credentials", client_id: ID, client_secret: SECRET });
    const url = new URL(sent[1]!.url);
    expect(url.origin + url.pathname).toBe("https://gateway.prod.bill.com/connect/v3/bills");
    expect(Object.fromEntries(url.searchParams)).toEqual({ max: String(BILL_PAGE_SIZE), sort: "updatedTime:asc", filters: "updatedTime:gte:2026-01-01T00:00:00.000Z" });
    const headers = new Headers(sent[1]!.init?.headers);
    expect([sent[1]!.init?.method, headers.get("authorization"), headers.has("devKey"), headers.has("sessionId")]).toEqual(["GET", "Bearer testtoken000000000001", false, false]);
    expect(BILL_PAGE_SIZE).toBe(100);
  });

  it("uses BILL's sandbox hosts when told to, and sends a page token it was given", async () => {
    const { fetch, sent } = scripted([token(), page([])]);
    await billClient({ clientId: ID, clientSecret: SECRET, environment: "sandbox", fetch, sleep: noSleep }).list("vendors", { since: "2026-01-01T00:00:00.000Z", page: "abc=" });
    expect(sent.map((s) => new URL(s.url).origin)).toEqual(["https://auth.stage.bill.com", "https://gateway.stage.bill.com"]);
    expect(new URL(sent[1]!.url).searchParams.get("page")).toBe("abc=");
    expect(BILL_HOSTS.sandbox.api).toBe("https://gateway.stage.bill.com/connect");
  });

  it("keeps the token until five minutes before it runs out", async () => {
    let now = NOW.getTime();
    const { fetch, sent } = scripted([token(3600), page([]), page([]), token(3600), page([])]);
    const client = billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep, now: () => new Date(now) });
    await client.list("bills", { since: RECEIVED });
    now += 55 * 60_000 - 1;
    await client.list("bills", { since: RECEIVED });
    now += 1;
    await client.list("bills", { since: RECEIVED });
    expect(sent.map((s) => new URL(s.url).pathname)).toEqual(["/authx/token", "/connect/v3/bills", "/connect/v3/bills", "/authx/token", "/connect/v3/bills"]);
  });

  it("treats an expires_in that isn't whole seconds as already run out", async () => {
    for (const expires of ["3600", 3600.5, -1, 0, 10_000_000, null]) {
      const { fetch, sent } = scripted([token(expires), page([]), token(), page([])]);
      const client = billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep, now: () => NOW });
      await client.list("bills", { since: RECEIVED });
      await client.list("bills", { since: RECEIVED });
      expect(sent.filter((s) => s.url.endsWith("/authx/token")), String(expires)).toHaveLength(2);
    }
    const { fetch, sent } = scripted([token(9_999_999), page([]), page([])]);
    const client = billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep, now: () => NOW });
    await client.list("bills", { since: RECEIVED });
    await client.list("bills", { since: RECEIVED });
    expect(sent.filter((s) => s.url.endsWith("/authx/token"))).toHaveLength(1);
  });

  it("signs in again once on a 401, then stops", async () => {
    const ok = scripted([token(), json(401, []), token(), page([])]);
    await billClient({ clientId: ID, clientSecret: SECRET, fetch: ok.fetch, sleep: noSleep }).list("bills", { since: RECEIVED });
    expect(ok.sent).toHaveLength(4);
    const bad = scripted([token(), json(401, []), token(), bdc(401, "BDC_1109")]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: bad.fetch, sleep: noSleep }).list("bills", { since: RECEIVED })).rejects.toThrow(
      new BillApiError("BILL turned down the token for bills: check the developer app's user can see bills", 401, "BDC_1109"),
    );
    const forbidden = scripted([token(), json(403, {})]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: forbidden.fetch, sleep: noSleep }).list("payments", { since: RECEIVED })).rejects.toMatchObject({ status: 403, message: "BILL turned down the token for payments: check the developer app's user can see payments" });
    expect(forbidden.sent).toHaveLength(2);
  });

  it("names a sign-in BILL turns down, and a sign-in without a token", async () => {
    for (const status of [400, 401]) {
      const { fetch } = scripted([json(status, { message: "Invalid client" })]);
      await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep }).list("bills", { since: RECEIVED })).rejects.toMatchObject({
        status,
        message: "BILL turned down the client id and secret: check BILL_CLIENT_ID, BILL_CLIENT_SECRET and BILL_ENVIRONMENT",
      });
    }
    const down = scripted([json(500, [{ code: "BDC_9999" }])]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: down.fetch, sleep: noSleep }).list("bills", { since: RECEIVED })).rejects.toMatchObject({ status: 500, code: "BDC_9999", message: "BILL sign-in answered HTTP 500" });
    for (const body of [{}, { access_token: "short" }, { access_token: "has a space in it ok" }, []]) {
      const { fetch } = scripted([json(200, body)]);
      await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep }).list("bills", { since: RECEIVED }), JSON.stringify(body)).rejects.toThrow("BILL sign-in answered without an access token");
    }
    const notJson = scripted([() => new Response("<html>", { status: 200 })]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: notJson.fetch, sleep: noSleep }).list("bills", { since: RECEIVED })).rejects.toThrow("BILL sign-in answered without an access token");
  });

  it("waits and retries when BILL is busy, and stops on the hourly limit", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const busy = scripted([token(), bdc(400, "BDC_1322"), json(429, {}, { "retry-after": "7" }), json(503, {}, { "retry-after": "999" }), page([])]);
    await billClient({ clientId: ID, clientSecret: SECRET, fetch: busy.fetch, sleep }).list("bills", { since: RECEIVED });
    expect(waits).toEqual([1000, 7000, 60_000]);
    const stuck = scripted([token(), bdc(400, "BDC_1322"), bdc(400, "BDC_1322"), bdc(400, "BDC_1322"), bdc(400, "BDC_1322")]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: stuck.fetch, sleep: noSleep }).list("bills", { since: RECEIVED })).rejects.toThrow(
      new BillApiError("BILL kept answering that 3 requests are already running for this organization", 400, "BDC_1322"),
    );
    const hourly = scripted([token(), bdc(429, "BDC_1144")]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: hourly.fetch, sleep: noSleep }).list("bills", { since: RECEIVED })).rejects.toMatchObject({
      code: "BDC_1144",
      message: "BILL's 20,000 requests for this hour are used up; the next sync picks up from the checkpoint",
    });
    expect(hourly.sent).toHaveLength(2);
    const once = scripted([token(), json(503, {}), page([])]);
    const slept: number[] = [];
    await billClient({ clientId: ID, clientSecret: SECRET, fetch: once.fetch, sleep: async (ms) => void slept.push(ms), retries: 1 }).list("bills", { since: RECEIVED });
    expect(slept).toEqual([1000]);
    const none = scripted([token(), json(503, {})]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch: none.fetch, sleep: noSleep, retries: 0 }).list("bills", { since: RECEIVED })).rejects.toMatchObject({ status: 503, message: "BILL bills answered HTTP 503" });
  });

  it("backs off further each time when BILL gives no wait", async () => {
    const waits: number[] = [];
    const busy = scripted([token(), json(503, {}), json(503, {}, { "retry-after": "soon" }), json(503, {}, { "retry-after": "0" }), page([])]);
    const sci = scripted([token(), json(503, {}, { "retry-after": "1e1" }), page([])]);
    const sciWaits: number[] = [];
    await billClient({ clientId: ID, clientSecret: SECRET, fetch: sci.fetch, sleep: async (ms) => void sciWaits.push(ms) }).list("bills", { since: RECEIVED });
    expect(sciWaits).toEqual([1000]);
    await billClient({ clientId: ID, clientSecret: SECRET, fetch: busy.fetch, sleep: async (ms) => void waits.push(ms) }).list("bills", { since: RECEIVED });
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("insists on a results list, and drops a page token that isn't one", async () => {
    const { fetch } = scripted([token(), json(200, { results: "no" })]);
    await expect(billClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep }).list("vendors", { since: RECEIVED })).rejects.toThrow("BILL vendors answered without a results list");
    const odd = scripted([token(), json(200, { results: [], nextPage: "has space" })]);
    expect((await billClient({ clientId: ID, clientSecret: SECRET, fetch: odd.fetch, sleep: noSleep }).list("vendors", { since: RECEIVED })).nextPage).toBeUndefined();
    const num = scripted([token(), json(200, { results: [], nextPage: 7 })]);
    expect((await billClient({ clientId: ID, clientSecret: SECRET, fetch: num.fetch, sleep: noSleep }).list("vendors", { since: RECEIVED })).nextPage).toBeUndefined();
  });

  it("reads BILL's error codes from its error list", () => {
    expect(billErrorCode([{ code: "BDC_1144" }, { code: "BDC_1" }])).toBe("BDC_1144");
    expect(billErrorCode({ code: "BDC_1322" })).toBe("BDC_1322");
    expect(billErrorCode([{ code: "Nope" }])).toBeUndefined();
    expect(billErrorCode([{ code: "BDC_1234567" }])).toBeUndefined();
    expect(billErrorCode([{ code: "xBDC_1" }])).toBeUndefined();
    expect(billErrorCode([])).toBeUndefined();
    expect(billErrorCode(undefined)).toBeUndefined();
  });

  it("checks its settings and what it is asked for before sending anything", async () => {
    const { fetch, sent } = scripted([]);
    expect(() => billClient({ clientId: "short", clientSecret: SECRET, fetch })).toThrow(new BillConfigError("BILL_CLIENT_ID is missing or not in the expected shape"));
    expect(() => billClient({ clientId: `${ID}!`, clientSecret: SECRET, fetch })).toThrow("BILL_CLIENT_ID is missing or not in the expected shape");
    expect(() => billClient({ clientId: "a".repeat(129), clientSecret: SECRET, fetch })).toThrow("BILL_CLIENT_ID");
    expect(() => billClient({ clientId: ID, clientSecret: "short", fetch })).toThrow("BILL_CLIENT_SECRET is missing or not in the expected shape");
    expect(() => billClient({ clientId: ID, clientSecret: `${SECRET} x`, fetch })).toThrow("BILL_CLIENT_SECRET");
    expect(() => billClient({ clientId: ID, clientSecret: SECRET, fetch, environment: "stage" as never })).toThrow('BILL_ENVIRONMENT must be "production" or "sandbox"');
    expect(() => billClient({ clientId: ID, clientSecret: SECRET, fetch, environment: "toString" as never })).toThrow("BILL_ENVIRONMENT");
    const client = billClient({ clientId: ID, clientSecret: SECRET, fetch });
    await expect(client.list("users" as never, { since: RECEIVED })).rejects.toThrow("not a BILL list this connector reads");
    await expect(client.list("bills", { since: "2026-01-01" })).rejects.toThrow("since must be an ISO time in UTC");
    await expect(client.list("bills", { since: `${RECEIVED}x` })).rejects.toThrow("since must be an ISO time in UTC");
    await expect(client.list("bills", { since: RECEIVED, page: "a&max=1" })).rejects.toThrow("not a BILL page token");
    expect(sent).toEqual([]);
  });
});

describe("BILL records", () => {
  it("keeps a vendor's name and how it is paid, and none of its contact, tax or bank details", () => {
    const vendor = VENDOR;
    const e = billEvent("vendors", vendor, RECEIVED);
    expect(e).toEqual({
      id: "bill_com_vendor:0090TEST00000001:2026-01-05T15:01:00.000Z",
      type: "accounting.vendor_updated",
      occurredAt: "2026-01-05T15:01:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "bill_com:vendor:0090TEST00000001:2026-01-05T15:01:00.000Z",
      payload: { vendorId: "bill:vendor:0090TEST00000001", name: "Test Supplier 1", active: true, currency: "USD", payBy: "ach" },
    });
    const text = JSON.stringify(e);
    for (const secret of ["example.com", "555-0100", "Example Street", "TEST-ACCT", "000123456789", "00-0000000", "Testville"]) expect(text).not.toContain(secret);
    expect(billEvent("vendors", { ...vendor, archived: true, name: "  ", billCurrency: "usd", paymentInformation: { payByType: "UNDEFINED" } }, RECEIVED).payload).toEqual({ vendorId: "bill:vendor:0090TEST00000001", name: "BILL vendor 0090TEST00000001", active: false });
    expect(billEvent("vendors", { ...vendor, paymentInformation: "ACH" }, RECEIVED).payload).not.toHaveProperty("payBy");
    // Only archived: true archives; a name's runs of space close up.
    expect(billEvent("vendors", { ...vendor, archived: "yes", name: " Test   Supplier\n 1 " }, RECEIVED).payload).toMatchObject({ name: "Test Supplier 1", active: true });
  });

  it("keeps a bill's numbers, dates, money and statuses, and not its description or lines", () => {
    const e = billEvent("bills", BILL, RECEIVED);
    expect(e).toMatchObject({ type: "accounting.bill_updated", occurredAt: "2026-01-15T16:01:00.000Z", idempotencyKey: "bill_com:bill:00n0TEST00000001:2026-01-15T16:01:00.000Z" });
    expect(e.payload).toEqual({
      billId: "bill:bill:00n0TEST00000001",
      vendorId: "bill:vendor:0090TEST00000001",
      vendorName: "Test Supplier 1",
      number: "TEST-INV-1",
      txnDate: "2026-01-15",
      dueDate: "2026-02-15",
      totalCents: 125_050,
      balanceCents: 100_050,
      paidCents: 25_000,
      scheduledCents: 0,
      currency: "USD",
      status: "unpaid",
      approvalStatus: "approved",
      archived: false,
    });
    expect(JSON.stringify(e)).not.toContain("Memo goods");
    expect(JSON.stringify(e)).not.toContain("14k chain");
    const sparse = billEvent("bills", { id: "00n0TEST00000009", updatedTime: "2026-01-15T16:00:00Z", vendorId: "bad", invoice: "x", amount: "12", archived: true, paymentStatus: "Paid" }, RECEIVED);
    expect(sparse.payload).toEqual({ billId: "bill:bill:00n0TEST00000009", totalCents: null, balanceCents: null, archived: true });
    // A vendor id must be a vendor's, and only archived: true archives.
    const odd = billEvent("bills", { ...BILL, vendorId: "00n0TEST00000002", archived: "true" }, RECEIVED).payload;
    expect(odd).not.toHaveProperty("vendorId");
    expect(odd.archived).toBe(false);
  });

  it("keeps a payment's money, status and the bills it paid, and not its card, check or confirmation numbers", () => {
    const e = billEvent("payments", PAYMENT, RECEIVED);
    expect(e).toMatchObject({ type: "accounting.payment_updated", occurredAt: "2026-02-10T09:01:00.000Z", idempotencyKey: "bill_com:payment:stp0TEST00000001:2026-02-10T09:01:00.000Z" });
    expect(e.payload).toEqual({
      paymentId: "bill:payment:stp0TEST00000001",
      vendorId: "bill:vendor:0090TEST00000001",
      vendorName: "Test Supplier 1",
      txnDate: "2026-02-10",
      totalCents: 125_050,
      fundingCents: 125_050,
      status: "paid",
      method: "ach",
      online: true,
      appliedTo: [{ type: "Bill", id: "bill:bill:00n0TEST00000001", amountCents: 125_050 }],
    });
    for (const secret of ["example.com", "TEST-CONF", "1001", "9876", "bac0TEST", "Invoice TEST-INV-1"]) expect(JSON.stringify(e.payload)).not.toContain(secret);
    // One bill and no split: the payment's own bill id. Neither: nothing applied.
    expect(billEvent("payments", ({ ...PAYMENT,  billPayments: undefined, amount: 10 }), RECEIVED).payload.appliedTo).toEqual([{ type: "Bill", id: "bill:bill:00n0TEST00000001", amountCents: 1000 }]);
    expect(billEvent("payments", ({ ...PAYMENT,  billPayments: [{ billId: "bad" }, "x"], billId: undefined }), RECEIVED).payload.appliedTo).toEqual([]);
    expect(billEvent("payments", ({ ...PAYMENT,  billPayments: "x", billId: "00n0TEST00000002" }), RECEIVED).payload.appliedTo).toEqual([{ type: "Bill", id: "bill:bill:00n0TEST00000002", amountCents: 125_050 }]);
    const split = ({ ...PAYMENT,  billPayments: [{ billId: "00n0TEST00000002", amount: 1 }, { billId: "00n0TEST00000003", amount: 2 }] });
    expect(billEvent("payments", split, RECEIVED).payload.appliedTo).toEqual([
      { type: "Bill", id: "bill:bill:00n0TEST00000002", amountCents: 100 },
      { type: "Bill", id: "bill:bill:00n0TEST00000003", amountCents: 200 },
    ]);
    expect(billEvent("payments", ({ ...PAYMENT,  onlinePayment: "true", fundingAmount: undefined }), RECEIVED).payload).toMatchObject({ online: false });
    expect(billEvent("payments", ({ ...PAYMENT,  fundingAmount: undefined }), RECEIVED).payload).not.toHaveProperty("fundingCents");
  });

  it("dead-letters a record with no id of its kind or no time", () => {
    const noId = billEvent("bills", { ...BILL, id: "0090TEST00000001" }, RECEIVED);
    expect(noId).toEqual({
      id: "bill_com_bill:unreadable:0090TEST00000001:2026-01-15T16:01:00.000_00:00",
      type: "accounting.bill_updated",
      occurredAt: undefined,
      receivedAt: RECEIVED,
      idempotencyKey: "bill_com:bill:unreadable:0090TEST00000001:2026-01-15T16:01:00.000+00:00",
      payload: { problem: "no bill id", billRecordId: "0090TEST00000001" },
    });
    const noTime = billEvent("vendors", { ...VENDOR, updatedTime: "yesterday" }, RECEIVED);
    expect(noTime).toMatchObject({ occurredAt: undefined, payload: { problem: "no updatedTime" } });
    const nothing = billEvent("payments", { id: 5, updatedTime: 5 }, RECEIVED);
    expect(nothing).toMatchObject({ occurredAt: undefined, idempotencyKey: "bill_com:payment:unreadable::", payload: { problem: "no payment id", billRecordId: "" } });
    const long = billEvent("payments", { id: "x".repeat(60), updatedTime: "y".repeat(60) }, RECEIVED);
    expect(long.idempotencyKey).toBe(`bill_com:payment:unreadable:${"x".repeat(40)}:${"y".repeat(40)}`);
    expect(long.id).toMatch(/^bill_com_[A-Za-z0-9_.:-]+$/);
  });

  it("reads BILL ids, money, times and days strictly", () => {
    expect(billId("00n0TEST1", "00n")).toBe("00n0TEST1");
    expect(billId("0090TEST1", "00n")).toBeUndefined();
    expect(billId("00n", "00n")).toBeUndefined();
    expect(billId("00n0TEST-1", "00n")).toBeUndefined();
    expect(billId(`00n${"a".repeat(38)}`, "00n")).toBeUndefined();
    expect(billId(`00n${"a".repeat(37)}`, "00n")).toBe(`00n${"a".repeat(37)}`);
    expect(billCents(1250.5)).toBe(125_050);
    expect(billCents(0.015)).toBe(2);
    expect(billCents(-10)).toBe(-1000);
    expect(billCents(99_999_999_999)).toBe(9_999_999_999_900);
    expect(billCents(1e11)).toBeNull();
    expect(billCents(-1e11)).toBeNull();
    expect(billCents(Number.NaN)).toBeNull();
    expect(billCents("12")).toBeNull();
    expect(billTime("2026-01-05T15:00:00.000+00:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(billTime("2026-01-05T10:00:00.000-05:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(billTime("2026-01-05T10:00:00.000-0500")).toBe("2026-01-05T15:00:00.000Z");
    expect(billTime("2026-01-05T15:00:00")).toBe("2026-01-05T15:00:00.000Z");
    expect(billTime("2026-01-05")).toBeUndefined();
    expect(billTime("x2026-01-05T15:00:00")).toBeUndefined();
    expect(billTime("2026-13-05T15:00:00")).toBeUndefined();
    expect(billTime(1_700_000_000)).toBeUndefined();
    expect(billDay("2026-02-28")).toBe("2026-02-28");
    expect(billDay("2026-02-30")).toBeUndefined();
    expect(billDay("2026-2-28")).toBeUndefined();
    expect(billDay("2026-02-28T00:00:00")).toBeUndefined();
    expect(billDay(20260228)).toBeUndefined();
  });
});

describe("the BILL connector", () => {
  it("reads vendors, then bills, then payments, six years back, and keeps the checkpoint after every page", async () => {
    const mock = account();
    const out = await batches(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(events(out).map((e) => e.type)).toEqual(["accounting.vendor_updated", "accounting.vendor_updated", "accounting.bill_updated", "accounting.bill_updated", "accounting.bill_updated", "accounting.payment_updated"]);
    expect(mock.lists.map((l) => [l.resource, l.query.filters])).toEqual([
      ["vendors", "updatedTime:gte:2020-11-10T12:00:00.000Z"],
      ["bills", "updatedTime:gte:2020-11-10T12:00:00.000Z"],
      ["payments", "updatedTime:gte:2020-11-10T12:00:00.000Z"],
    ]);
    expect(out.map(cursorOf)).toEqual([
      { pass: "historical", list: 1, page: null, pages: 0, since: "2020-11-10T12:00:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" },
      { pass: "historical", list: 2, page: null, pages: 0, since: "2020-11-10T12:00:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" },
      { pass: "historical", list: 3, page: null, pages: 0, since: "2020-11-10T12:00:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" },
    ]);
    expect(mock.tokens).toHaveLength(1);
    expect(BILL_OVERLAP_MS).toBe(300_000);
    expect(BILL_MAX_PAGES).toBe(10_000);
  });

  it("pages through a long list with BILL's page tokens, and resumes from the page it reached", async () => {
    const mock = account({ vendors: [], payments: [], bills: LONG });
    const out = await batches(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out.map((b) => b.events.length)).toEqual([0, 100, 100, 30, 0]);
    expect(out.map((b) => [cursorOf(b).list, cursorOf(b).page, cursorOf(b).pages])).toEqual([
      [1, null, 0],
      [1, "p100", 1],
      [1, "p200", 2],
      [2, null, 0],
      [3, null, 0],
    ]);
    expect(mock.lists.filter((l) => l.resource === "bills").map((l) => l.query.page)).toEqual([undefined, "p100", "p200"]);
    // Resumed after the second page: the third page and payments only.
    const again = account({ vendors: [], payments: [], bills: LONG });
    const rest = await batches(connector(again).historicalImport({ organizationId: TEST_ORG, cursor: out[2]!.cursor! }));
    expect(rest.map((b) => b.events.length)).toEqual([30, 0]);
    expect(again.lists.map((l) => [l.resource, l.query.page])).toEqual([
      ["bills", "p200"],
      ["payments", undefined],
    ]);
  });

  it("does nothing once the historical import is done", async () => {
    const mock = account();
    const done: BillCursor = { pass: "historical", list: 3, page: null, pages: 0, since: "2020-11-10T12:00:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" };
    expect(await batches(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) }))).toEqual([]);
    expect(mock.tokens).toEqual([]);
  });

  it("asks an incremental sync from the last pass's start less the overlap, or a day back with no checkpoint", async () => {
    const after: BillCursor = { pass: "historical", list: 3, page: null, pages: 0, since: "2020-11-10T12:00:00.000Z", nextFrom: "2026-11-09T11:55:00.000Z" };
    const mock = account();
    const out = await batches(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(after) }));
    expect(mock.lists.map((l) => l.query.filters)).toEqual(Array(3).fill("updatedTime:gte:2026-11-09T11:55:00.000Z"));
    expect(cursorOf(out.at(-1)!)).toEqual({ pass: "incremental", list: 3, page: null, pages: 0, since: "2026-11-09T11:55:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" });
    const fresh = account();
    await batches(connector(fresh).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(fresh.lists[0]!.query.filters).toBe("updatedTime:gte:2026-11-09T12:00:00.000Z");
    const wider = account();
    await batches(connector(wider, { incrementalLookbackHours: 48 }).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(wider.lists[0]!.query.filters).toBe("updatedTime:gte:2026-11-08T12:00:00.000Z");
    // An interrupted incremental pass goes on where it stopped; a finished one starts the next from its nextFrom.
    const mid: BillCursor = { pass: "incremental", list: 2, page: null, pages: 0, since: "2026-11-09T11:55:00.000Z", nextFrom: "2026-11-10T09:00:00.000Z" };
    const resumed = account();
    await batches(connector(resumed).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(resumed.lists.map((l) => [l.resource, l.query.filters])).toEqual([["payments", "updatedTime:gte:2026-11-09T11:55:00.000Z"]]);
    const finished = account();
    await batches(connector(finished).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...mid, list: 3 }) }));
    expect(finished.lists[0]!.query.filters).toBe("updatedTime:gte:2026-11-10T09:00:00.000Z");
    // A historical import with an incremental checkpoint starts its own pass.
    const hist = account();
    await batches(connector(hist).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(mid) }));
    expect(hist.lists[0]!.query.filters).toBe("updatedTime:gte:2020-11-10T12:00:00.000Z");
  });

  it("stops on a page token that repeats or never ends", async () => {
    const repeat: BillClient = { list: async () => ({ results: [{}], nextPage: "same" }) };
    const c = billComConnector({ clientId: ID, clientSecret: SECRET, client: repeat, now: () => NOW });
    const it1 = c.historicalImport({ organizationId: TEST_ORG, cursor: null })[Symbol.asyncIterator]();
    await it1.next();
    await expect(it1.next()).rejects.toThrow("BILL vendors kept giving more pages after 2");
    let n = 1;
    const endless: BillClient = { list: async () => ({ results: [{}], nextPage: `p${n++}` }) };
    const near: BillCursor = { pass: "historical", list: 0, page: "p0", pages: BILL_MAX_PAGES - 2, since: "2020-11-10T12:00:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" };
    const c2 = billComConnector({ clientId: ID, clientSecret: SECRET, client: endless, now: () => NOW });
    const it2 = c2.historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(near) })[Symbol.asyncIterator]();
    expect(cursorOf((await it2.next()).value as SourceBatch).pages).toBe(BILL_MAX_PAGES - 1);
    await expect(it2.next()).rejects.toThrow(`BILL vendors kept giving more pages after ${BILL_MAX_PAGES}`);
    // An empty page with a token ends the list.
    const empty: BillClient = { list: async () => ({ results: [], nextPage: "more" }) };
    const out = await batches(billComConnector({ clientId: ID, clientSecret: SECRET, client: empty, now: () => NOW }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(out.map((b) => cursorOf(b).list)).toEqual([1, 2, 3]);
  });

  it("survives every runSync scenario, retrying when BILL is busy", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(account({ busy: 1 })), expected: { ingested: 6 } });
    expect(result.full.batches).toBe(3);
    const dead = await checkConnectorSync({ makeConnector: () => connector(account({ bills: [...BILLS.slice(1), { ...BILL, id: "bad" }] })), expected: { ingested: 5, deadLettered: 1 } });
    expect(dead.full.deadLettered).toBe(1);
  });

  it("stops on BILL's hourly limit", async () => {
    await expect(batches(connector(account({ hourlyLimitReached: true })).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toMatchObject({ code: "BDC_1144" });
  });

  it("checks the checkpoint it resumes from", () => {
    const good: BillCursor = { pass: "incremental", list: 1, page: "p100", pages: 1, since: "2026-11-09T11:55:00.000Z", nextFrom: "2026-11-10T11:55:00.000Z" };
    expect(parseBillCursor(JSON.stringify({ ...good, extra: 1 }))).toEqual(good);
    expect(parseBillCursor(null)).toBeNull();
    const bad = [
      "{",
      "null",
      { ...good, pass: "full" },
      { ...good, list: 4 },
      { ...good, list: -1 },
      { ...good, list: 1.5 },
      { ...good, page: "has space" },
      { ...good, page: 3 },
      { ...good, pages: -1 },
      { ...good, pages: BILL_MAX_PAGES + 1 },
      { ...good, since: "2026-11-09" },
      { ...good, since: "2026-02-30T00:00:00.000Z" },
      { ...good, nextFrom: undefined },
    ];
    for (const c of bad) expect(() => parseBillCursor(typeof c === "string" ? c : JSON.stringify(c)), JSON.stringify(c)).toThrow("BILL checkpoint is not in the expected shape");
    expect(parseBillCursor(JSON.stringify({ ...good, list: 3, page: null, pages: BILL_MAX_PAGES }))).toMatchObject({ list: 3 });
  });

  it("rejects bad options", () => {
    expect(() => connector(account(), { historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(account(), { historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(account(), { incrementalLookbackHours: 0 })).toThrow("incrementalLookbackHours must be a positive whole number");
    expect(() => billComConnector({ clientId: "x", clientSecret: SECRET })).toThrow("BILL_CLIENT_ID");
  });

  it("uses only synthetic data, declares no writes, and the write gate turns every one down", async () => {
    assertSynthetic({ VENDORS, BILLS, PAYMENTS });
    expect(BILL_WRITES).toEqual([]);
    expect(await assertWritesRefused(connector())).toEqual([]);
    expect(connector().source).toBe("bill_com");
    expect(connector().handleWebhook).toBeUndefined();
  });
});
