import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  AUTHORIZE_NET_MOCK_REQUESTS,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  assertWritesRefused,
  authorizeNetBatch,
  authorizeNetBatchId,
  authorizeNetDetails,
  authorizeNetDocMock,
  authorizeNetTransId,
  authorizeNetTransaction,
  checkConnectorSync,
  tamper,
  testPipeline,
  type AuthorizeNetMock,
  type AuthorizeNetMockData,
  type AuthorizeNetMockRecord,
} from "@karatos/connector-testkit";
import {
  AUTHORIZE_NET_API_URLS,
  AUTHORIZE_NET_OVERLAP_MS,
  AUTHORIZE_NET_READ_REQUESTS,
  AUTHORIZE_NET_WEBHOOK_EVENTS,
  AUTHORIZE_NET_WRITES,
  AuthorizeNetApiError,
  AuthorizeNetConfigError,
  authorizeNetBatchEvents,
  authorizeNetCents,
  authorizeNetClient,
  authorizeNetConnector,
  authorizeNetDate,
  authorizeNetList,
  authorizeNetMethod,
  authorizeNetTime,
  authorizeNetTransactionEvents,
  authorizeNetWebhookChange,
  parseAuthorizeNetCursor,
  verifyAuthorizeNetWebhook,
  type AuthorizeNetClient,
  type AuthorizeNetConnectorOptions,
  type AuthorizeNetCursor,
  type AuthorizeNetRequestType,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const LOGIN = ["test", "login", "0"].join("");
const KEY = ["TEST", "0".repeat(12)].join("");
const NOW = () => new Date("2026-01-20T00:00:00Z");
const RECEIVED = "2026-01-20T00:00:00.000Z";
const DAY = 86_400_000;

function merchant(overrides: Partial<AuthorizeNetMockData> = {}): AuthorizeNetMockData {
  for (const b of [authorizeNetBatch, authorizeNetTransaction]) b.reset();
  const [card, echeckBatch] = authorizeNetBatch.many(2);
  const t = authorizeNetTransaction;
  const charge = t.one();
  const voided = t.one({ transactionStatus: "voided", accountType: "AmericanExpress" });
  const refund = t.one({ transactionStatus: "refundSettledSuccessfully", settleAmount: 100 });
  // One record Authorize.net returned without its submit time: it is dead-lettered, not given a made-up one.
  const timeless = t.one();
  delete timeless.submitTimeUTC;
  const chargeback = t.one({ transactionStatus: "chargeback", accountType: "MasterCard", settleAmount: 25 });
  const echeck = t.one({ accountType: "eCheck", accountNumber: "XXXX6789", hasReturnedItems: true, marketType: "Retail" });
  const pending = t.one({ transactionStatus: "authorizedPendingCapture" });
  const captured = t.one({ transactionStatus: "capturedPendingSettlement", marketType: "MOTO" });
  return {
    apiLoginId: LOGIN,
    transactionKey: KEY,
    batches: [card!, { ...echeckBatch!, paymentMethod: "eCheck" }],
    transactions: { [String(card!.batchId)]: [charge, voided, refund, timeless], [String(echeckBatch!.batchId)]: [chargeback, echeck] },
    unsettled: [pending, captured],
    details: {
      [String(refund.transId)]: authorizeNetDetails(refund, { transactionType: "refundTransaction", refTransId: charge.transId }),
      [String(chargeback.transId)]: authorizeNetDetails(chargeback, { refTransId: charge.transId }),
    },
    ...overrides,
  };
}

const options = (mock: AuthorizeNetMock, extra: Partial<AuthorizeNetConnectorOptions> = {}): AuthorizeNetConnectorOptions => ({
  apiLoginId: LOGIN,
  transactionKey: KEY,
  environment: "sandbox",
  fetch: mock.fetch,
  sleep: async () => {},
  now: NOW,
  ...extra,
});

const connector = (mock: AuthorizeNetMock, extra: Partial<AuthorizeNetConnectorOptions> = {}) => authorizeNetConnector(options(mock, extra));
const failure = (p: Promise<unknown>) => p.then(() => new Error("did not fail"), (e: unknown) => e as Error);
type Sent = { url: string; type: string; fields: Record<string, unknown> };

/** A fetch that keeps each request's type and fields, without its credentials, before the mock answers. */
function recording(mock: AuthorizeNetMock) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, Record<string, unknown>>;
    const type = Object.keys(body)[0]!;
    const { merchantAuthentication: _auth, ...fields } = body[type]!;
    sent.push({ url: String(input), type, fields });
    return mock.fetch(input as string, init);
  };
  return { fetch, sent };
}

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(`﻿${JSON.stringify(body)}`, { status, headers });
const OK = { resultCode: "Ok", message: [{ code: "I00001", text: "Successful." }] };

/** A client answering from a function, for paging and currency cases the mock doesn't shape. */
function stubClient(respond: (type: AuthorizeNetRequestType, fields: Record<string, unknown>) => Record<string, unknown>): AuthorizeNetClient & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    environment: "sandbox",
    sent,
    async request(type, fields = {}) {
      sent.push({ url: "", type, fields: fields as Record<string, unknown> });
      return respond(type, fields as Record<string, unknown>);
    },
  };
}

describe("Authorize.net client", () => {
  it("checks its settings, naming them but never their values", () => {
    const base = options(authorizeNetDocMock(merchant()));
    expect(() => authorizeNetClient({ ...base, transactionKey: " " })).toThrow(new AuthorizeNetConfigError("set AUTHORIZE_NET_API_LOGIN_ID and AUTHORIZE_NET_TRANSACTION_KEY"));
    expect(() => authorizeNetClient({ ...base, apiLoginId: "test login" })).toThrow("AUTHORIZE_NET_API_LOGIN_ID must be the API Login ID");
    expect(() => authorizeNetClient({ ...base, apiLoginId: "x".repeat(26) })).toThrow(AuthorizeNetConfigError);
    expect(() => authorizeNetClient({ ...base, transactionKey: `${KEY}0` })).toThrow("AUTHORIZE_NET_TRANSACTION_KEY must be the 16-character Transaction Key");
    for (const environment of ["", "live", "test", "Production"]) {
      expect(() => authorizeNetClient({ ...base, environment })).toThrow("AUTHORIZE_NET_ENVIRONMENT must be production or sandbox");
    }
    expect(authorizeNetClient({ ...base, apiLoginId: ` ${LOGIN} `, transactionKey: ` ${KEY} ` }).environment).toBe("sandbox");
    for (const e of [() => authorizeNetClient({ ...base, transactionKey: `${KEY}0` }), () => authorizeNetClient({ ...base, apiLoginId: `${LOGIN}!` })]) {
      expect(() => e()).toThrow(expect.objectContaining({ message: expect.not.stringContaining(KEY) }));
    }
  });

  it("sends only Transaction Reporting requests, refusing everything that could move money before it leaves", async () => {
    const mock = authorizeNetDocMock(merchant());
    const client = authorizeNetClient(options(mock));
    for (const type of ["createTransactionRequest", "createCustomerProfileRequest", "ARBCreateSubscriptionRequest", "updateSplitTenderGroupRequest", "constructor", "__proto__", "toString"]) {
      await expect(client.request(type as never)).rejects.toThrow(new AuthorizeNetConfigError("the Authorize.net connector only sends Transaction Reporting requests"));
    }
    expect(AUTHORIZE_NET_READ_REQUESTS).toEqual(["getMerchantDetailsRequest", "getSettledBatchListRequest", "getTransactionListRequest", "getUnsettledTransactionListRequest", "getTransactionDetailsRequest"]);
    // Every request the client may send is one the docs list under reporting.
    for (const type of AUTHORIZE_NET_READ_REQUESTS) expect(AUTHORIZE_NET_MOCK_REQUESTS).toContain(type);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("sends only fields it checked itself", async () => {
    const mock = authorizeNetDocMock(merchant());
    const client = authorizeNetClient(options(mock));
    const window = { firstSettlementDate: "2026-01-01T00:00:00Z", lastSettlementDate: "2026-02-01T00:00:00Z" };
    const refused: [AuthorizeNetRequestType, Record<string, unknown>, string | RegExp][] = [
      ["getUnsettledTransactionListRequest", { batchId: "1" }, "getUnsettledTransactionListRequest doesn't take batchId"],
      ["getTransactionDetailsRequest", { transId: "1", amount: 5 }, "doesn't take amount"],
      ["getTransactionDetailsRequest", { transId: "1 OR 1=1" }, "transId must be Authorize.net's numeric id"],
      ["getTransactionListRequest", { batchId: 12 }, "batchId must be"],
      ["getSettledBatchListRequest", { ...window, includeStatistics: "yes" }, "includeStatistics must be true or false"],
      ["getSettledBatchListRequest", { ...window, firstSettlementDate: "2026-01-01" }, "firstSettlementDate must be an ISO time in UTC"],
      ["getSettledBatchListRequest", { ...window, lastSettlementDate: "2026-02-01T00:00:00+05:00" }, "lastSettlementDate must be"],
      ["getSettledBatchListRequest", { ...window, lastSettlementDate: "2026-13-45T00:00:00Z" }, "lastSettlementDate must be"],
      ["getSettledBatchListRequest", { ...window, lastSettlementDate: "2026-02-01T00:00:01Z" }, "at most 31 days apart"],
      ["getSettledBatchListRequest", { firstSettlementDate: window.lastSettlementDate, lastSettlementDate: window.firstSettlementDate }, "at most 31 days apart"],
      ["getSettledBatchListRequest", {}, "at most 31 days apart"],
      ["getTransactionListRequest", { batchId: "1", sorting: { orderBy: "settleAmount", orderDescending: false } }, "sorting must be by id or submitTimeUTC"],
      ["getTransactionListRequest", { batchId: "1", sorting: { orderBy: "id", orderDescending: "false" } }, "sorting must be"],
      ["getTransactionListRequest", { batchId: "1", paging: { limit: 1001, offset: 1 } }, "paging takes a limit from 1 to 1000"],
      ["getTransactionListRequest", { batchId: "1", paging: { limit: 1000, offset: 0 } }, "paging takes"],
      ["getTransactionListRequest", { batchId: "1", paging: { limit: 10.5, offset: 1 } }, "paging takes"],
    ];
    for (const [type, fields, message] of refused) await expect(client.request(type, fields as never), JSON.stringify(fields)).rejects.toThrow(message);
    expect(mock.fetch.calls).toEqual([]);
  });

  it("posts JSON to the sandbox endpoint, credentials first and fields in the schema's order, as the docs' examples write them", async () => {
    const seen: { method: string; url: string; type: string | null; body: string }[] = [];
    const mock = authorizeNetDocMock(merchant());
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({ method: init?.method ?? "GET", url: String(input), type: new Headers(init?.headers).get("content-type"), body: String(init?.body) });
      return mock.fetch(input as string, init);
    };
    const client = authorizeNetClient(options(mock, { fetch }));
    await client.request("getTransactionListRequest", { paging: { offset: 2, limit: 1000 }, sorting: { orderDescending: false, orderBy: "id" }, batchId: authorizeNetBatchId(1) });
    expect(seen[0]).toMatchObject({ method: "POST", url: "https://apitest.authorize.net/xml/v1/request.api", type: "application/json" });
    expect(seen[0]!.body).toBe(
      JSON.stringify({
        getTransactionListRequest: {
          merchantAuthentication: { name: LOGIN, transactionKey: KEY },
          batchId: authorizeNetBatchId(1),
          sorting: { orderBy: "id", orderDescending: "false" },
          paging: { limit: "1000", offset: "2" },
        },
      }),
    );
    await client.request("getSettledBatchListRequest", { lastSettlementDate: "2026-02-01T00:00:00Z", firstSettlementDate: "2026-01-01T00:00:00Z", includeStatistics: true });
    expect(Object.keys(JSON.parse(seen[1]!.body).getSettledBatchListRequest)).toEqual(["merchantAuthentication", "includeStatistics", "firstSettlementDate", "lastSettlementDate"]);
    expect(JSON.parse(seen[1]!.body).getSettledBatchListRequest.includeStatistics).toBe("true");
  });

  it("keeps the sandbox and production endpoints apart", async () => {
    expect(AUTHORIZE_NET_API_URLS).toEqual({ production: "https://api.authorize.net/xml/v1/request.api", sandbox: "https://apitest.authorize.net/xml/v1/request.api" });
    const sandbox = authorizeNetDocMock(merchant());
    const live = authorizeNetDocMock(merchant({ environment: "production" }));
    await expect(authorizeNetClient(options(live, { environment: "production" })).request("getMerchantDetailsRequest")).resolves.toMatchObject({ currencies: ["USD"] });
    await expect(authorizeNetClient(options(sandbox, { environment: "production" })).request("getMerchantDetailsRequest")).rejects.toThrow(UndocumentedRequestError);
    await expect(authorizeNetClient(options(live, { environment: "sandbox" })).request("getMerchantDetailsRequest")).rejects.toThrow(/apitest\.authorize\.net.*not in the vendor's docs/);
    expect(live.fetch.calls.map((c) => c.url)).toEqual(["https://api.authorize.net/xml/v1/request.api"]);
  });

  it("reads past the byte order mark Authorize.net puts before its JSON", async () => {
    const mock = authorizeNetDocMock(merchant());
    const raw = new Uint8Array(await (await mock.fetch(AUTHORIZE_NET_API_URLS.sandbox, { method: "POST", body: JSON.stringify({ getMerchantDetailsRequest: {} }) })).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // fetch's text() drops the mark as it decodes; a fetch that passes it through is read the same.
    const passThrough = (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => `﻿${JSON.stringify({ currencies: ["USD"], messages: OK })}` })) as unknown as typeof globalThis.fetch;
    await expect(authorizeNetClient(options(mock, { fetch: passThrough })).request("getMerchantDetailsRequest")).resolves.toMatchObject({ currencies: ["USD"] });
    const notJson = async () => new Response("<html>maintenance</html>", { status: 200 });
    await expect(authorizeNetClient(options(mock, { fetch: notJson })).request("getMerchantDetailsRequest")).rejects.toThrow(new AuthorizeNetApiError("Authorize.net did not answer with JSON", 200));
    const scalar = async () => new Response("5", { status: 200 });
    await expect(authorizeNetClient(options(mock, { fetch: scalar })).request("getMerchantDetailsRequest")).rejects.toThrow("did not answer with JSON");
  });

  it("reports Authorize.net's errors, which come as HTTP 200, cut short with a hint, and never the key", async () => {
    const wrong = authorizeNetDocMock(merchant({ transactionKey: ["TEST", "1".repeat(12)].join("") }));
    const auth = await failure(authorizeNetClient(options(wrong)).request("getMerchantDetailsRequest"));
    expect(auth).toMatchObject({ name: "AuthorizeNetApiError", status: 200, code: "E00007" });
    expect(auth.message).toBe(
      "Authorize.net refused getMerchantDetailsRequest (E00007: User authentication failed due to invalid authentication values.); check AUTHORIZE_NET_API_LOGIN_ID, AUTHORIZE_NET_TRANSACTION_KEY and AUTHORIZE_NET_ENVIRONMENT",
    );
    const denied = async () => answer({ messages: { resultCode: "Error", message: [{ code: "E00011", text: "Access denied. You do not have permissions to call the Transaction Details API." }] } });
    await expect(authorizeNetClient(options(wrong, { fetch: denied })).request("getMerchantDetailsRequest")).rejects.toThrow(/\(E00011: Access denied.*\); turn on the Transaction Details API in the Merchant Interface/);
    const long = async () => answer({ messages: { resultCode: "Error", message: { code: "E00003", text: "x".repeat(500) } } });
    const cut = await failure(authorizeNetClient(options(wrong, { fetch: long })).request("getMerchantDetailsRequest"));
    expect([cut.message.length < 280, (cut as AuthorizeNetApiError).code]).toEqual([true, "E00003"]);
    const bare = async () => answer({ messages: { resultCode: "Error" } });
    await expect(authorizeNetClient(options(wrong, { fetch: bare })).request("getMerchantDetailsRequest")).rejects.toThrow(new AuthorizeNetApiError("Authorize.net refused getMerchantDetailsRequest", 200));
    const missing = await failure(authorizeNetClient(options(wrong)).request("getTransactionDetailsRequest", { transId: "1" }));
    expect(missing.message).toContain("E00007");
    const http = async () => new Response("Server Error", { status: 500 });
    await expect(authorizeNetClient(options(wrong, { fetch: http })).request("getMerchantDetailsRequest")).rejects.toThrow(new AuthorizeNetApiError("Authorize.net answered HTTP 500", 500));
    for (const message of [auth.message, cut.message]) for (const secret of [KEY, LOGIN]) expect(message).not.toContain(secret);
  });

  it("waits out throttling, honouring Retry-After up to a minute, then leaves the error to runSync", async () => {
    const mock = authorizeNetDocMock(merchant());
    const answers = [new Response("", { status: 503, headers: { "retry-after": "7" } }), new Response("", { status: 429 }), new Response("", { status: 429, headers: { "retry-after": "3600" } })];
    const waits: number[] = [];
    const throttled: typeof globalThis.fetch = async (input, init) => answers.shift() ?? mock.fetch(input as string, init);
    await expect(authorizeNetClient(options(mock, { fetch: throttled, sleep: async (ms) => void waits.push(ms) })).request("getMerchantDetailsRequest")).resolves.toBeDefined();
    expect(waits).toEqual([7000, 2000, 60_000]);
    let tries = 0;
    const always = async () => {
      tries++;
      return new Response("", { status: 503, headers: { "retry-after": "soon" } });
    };
    waits.length = 0;
    const error = await failure(authorizeNetClient(options(mock, { fetch: always, sleep: async (ms) => void waits.push(ms) })).request("getMerchantDetailsRequest"));
    expect([waits, tries, error.message]).toEqual([[1000, 2000, 4000], 4, "Authorize.net answered HTTP 503"]);
  });
});

describe("Authorize.net mock", () => {
  const post = (mock: AuthorizeNetMock, body: unknown) => mock.fetch(AUTHORIZE_NET_API_URLS.sandbox, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const auth = { merchantAuthentication: { name: LOGIN, transactionKey: KEY } };

  it("refuses fields out of the schema's order, unknown requests and bad JSON, as the API does", async () => {
    const mock = authorizeNetDocMock(merchant());
    expect(await post(mock, { getTransactionListRequest: { ...auth, paging: { limit: "10", offset: "1" }, batchId: authorizeNetBatchId(1) } })).toMatchObject({ messages: { resultCode: "Error", message: [{ code: "E00003" }] } });
    expect(await post(mock, { getTransactionListRequest: { batchId: authorizeNetBatchId(1), ...auth } })).toMatchObject({ messages: { message: [{ code: "E00007" }] } });
    expect(await post(mock, { getTransactionListRequest: { ...auth, batchId: authorizeNetBatchId(1), amount: "1" } })).toMatchObject({ messages: { message: [{ code: "E00003" }] } });
    expect(await post(mock, "{")).toMatchObject({ messages: { message: [{ code: "E00003" }] } });
    await expect(post(mock, { createTransactionRequest: auth })).rejects.toThrow(UndocumentedRequestError);
    await expect(post(mock, { a: {}, b: {} })).rejects.toThrow(UndocumentedRequestError);
    await expect(post(mock, [])).rejects.toThrow(/no request/);
    expect(mock.requests).toEqual(["getTransactionListRequest", "getTransactionListRequest", "getTransactionListRequest"]);
  });

  it("checks dates, the 31-day range, ids, sorting and paging", async () => {
    const mock = authorizeNetDocMock(merchant());
    const batches = (first: string, last: string, extra = {}) => post(mock, { getSettledBatchListRequest: { ...auth, ...extra, firstSettlementDate: first, lastSettlementDate: last } });
    expect(await batches("soon", "2026-01-10T00:00:00Z")).toMatchObject({ messages: { resultCode: "Error" } });
    expect(await batches("2025-12-01T00:00:00Z", "2026-01-10T00:00:00Z")).toMatchObject({ messages: { message: [{ text: "The date range cannot exceed 31 days." }] } });
    const plain = await batches("2026-01-01T00:00:00", "2026-01-10T00:00:00");
    expect((plain.batchList as AuthorizeNetMockRecord[]).map((b) => [b.batchId, "statistics" in b])).toEqual([[authorizeNetBatchId(1), false], [authorizeNetBatchId(2), false]]);
    expect(await batches("2025-01-01T00:00:00Z", "2025-01-10T00:00:00Z")).toMatchObject({ messages: { message: [{ code: "I00004" }] } });
    const list = (fields: object) => post(mock, { getTransactionListRequest: { ...auth, ...fields } });
    expect(await list({ batchId: "x" })).toMatchObject({ messages: { resultCode: "Error" } });
    expect(await list({ batchId: authorizeNetBatchId(1), sorting: { orderBy: "amount", orderDescending: "false" } })).toMatchObject({ messages: { resultCode: "Error" } });
    expect(await list({ batchId: authorizeNetBatchId(1), paging: { limit: "5000", offset: "1" } })).toMatchObject({ messages: { resultCode: "Error" } });
    const newest = await list({ batchId: authorizeNetBatchId(1), sorting: { orderBy: "id", orderDescending: "true" }, paging: { limit: "2", offset: "2" } });
    expect([(newest.transactions as AuthorizeNetMockRecord[]).map((t) => t.transId), newest.totalNumInSet]).toEqual([[authorizeNetTransId(2), authorizeNetTransId(1)], 4]);
    const byTime = await list({ batchId: authorizeNetBatchId(2), sorting: { orderBy: "submitTimeUTC", orderDescending: "true" } });
    expect((byTime.transactions as AuthorizeNetMockRecord[]).map((t) => t.transId)).toEqual([authorizeNetTransId(6), authorizeNetTransId(5)]);
    expect(await list({ batchId: "1" })).toMatchObject({ totalNumInSet: 0, messages: { message: [{ code: "I00004" }] } });
    expect(await post(mock, { getTransactionDetailsRequest: { ...auth, transId: "1" } })).toMatchObject({ messages: { message: [{ code: "E00040" }] } });
  });
});

describe("Authorize.net normalization", () => {
  const sync = async (data = merchant()) => {
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(authorizeNetDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    return { report, events: memory.events };
  };
  const ref = (n: number) => `authorize_net:transaction:${authorizeNetTransId(n)}`;
  const batch = (n: number) => `authorize_net:batch:${authorizeNetBatchId(n)}`;

  it("keeps the money, card brand and links, and nothing personal", async () => {
    const { events } = await sync();
    const text = JSON.stringify(events.map((e) => e.payload));
    for (const personal of ["Test Customer", "XXXX", "1111", "6789", "INV-TEST", "@", "555", "Test Street", "Testville", "192.0.2", "CUST-TEST", "Synthetic", "700001"]) {
      expect(text).not.toContain(personal);
    }
    const keys = new Set(events.flatMap((e) => Object.keys(e.payload)));
    for (const field of ["firstName", "lastName", "accountNumber", "invoiceNumber", "customerIP", "email", "billTo", "phoneNumber", "authCode"]) expect(keys).not.toContain(field);
    const charge = events.find((e) => e.payload.chargeId === ref(1))!;
    expect(charge).toMatchObject({ type: "payment.charge_updated", occurredAt: "2026-01-01T01:00:00.000Z", idempotencyKey: `authorize_net:transaction:${authorizeNetTransId(1)}:settledSuccessfully` });
    expect(charge.payload).toEqual({
      chargeId: ref(1),
      status: "succeeded",
      gatewayStatus: "settledSuccessfully",
      paid: true,
      captured: true,
      voided: false,
      amountCents: 62_525,
      currency: "USD",
      batchId: batch(1),
      capturedCents: 62_525,
      disputed: false,
      method: "card",
      cardBrand: "visa",
      channel: "online",
      customerId: "authorize_net:customer_profile:500001",
    });
    expect(events.find((e) => e.payload.chargeId === ref(2))!.payload).toMatchObject({ status: "failed", voided: true, captured: false, capturedCents: 0, cardBrand: "amex" });
    expect(events.find((e) => e.type === "payment.refund_updated")!.payload).toEqual({ refundId: ref(3), chargeId: ref(1), amountCents: 10_000, currency: "USD", batchId: batch(1), status: "succeeded", reason: null });
    expect(events.find((e) => e.type === "payment.dispute_updated")!.payload).toEqual({ disputeId: ref(5), chargeId: ref(1), amountCents: 2_500, currency: "USD", batchId: batch(2), reason: "chargeback", status: "funds_withdrawn" });
    expect(events.find((e) => e.payload.chargeId === ref(6))!.payload).toMatchObject({ method: "other", cardBrand: null, disputed: true, channel: "in_store" });
    expect(events.find((e) => e.payload.chargeId === ref(7))!.payload).toMatchObject({ status: "pending", paid: false, captured: false });
    expect(events.find((e) => e.payload.chargeId === ref(8))!.payload).toMatchObject({ status: "succeeded", captured: true, channel: "phone_or_mail" });
    expect(events.find((e) => e.payload.chargeId === ref(8))!.payload).not.toHaveProperty("batchId");
    expect(events.find((e) => e.type === "payout.updated")!).toMatchObject({
      occurredAt: "2026-01-02T03:00:00.000Z",
      idempotencyKey: `authorize_net:batch:${authorizeNetBatchId(1)}:settledSuccessfully`,
      payload: {
        payoutId: batch(1),
        amountCents: 120_000,
        currency: "USD",
        status: "paid",
        method: "card",
        type: "settlement",
        arrivalDate: null,
        settledOn: "2026-01-02",
        chargeCents: 130_000,
        refundCents: 10_000,
        chargebackCents: 2_500,
        returnedItemCents: null,
        chargeCount: 3,
        refundCount: 1,
        voidCount: 1,
        declineCount: 1,
      },
    });
    expect(events.filter((e) => e.type === "payout.updated").map((e) => e.payload.method)).toEqual(["card", "echeck"]);
  });

  it("keys each transaction by its id and status, so a status change is stored once and a replay is a duplicate", () => {
    const t = authorizeNetTransaction.one();
    const ctx = { currency: "USD" };
    const settled = authorizeNetTransactionEvents(t, ctx, RECEIVED)[0]!;
    expect(authorizeNetTransactionEvents({ ...t }, ctx, "2026-02-01T00:00:00.000Z")[0]!.idempotencyKey).toBe(settled.idempotencyKey);
    expect(authorizeNetTransactionEvents({ ...t, transactionStatus: "voided" }, ctx, RECEIVED)[0]!.idempotencyKey).not.toBe(settled.idempotencyKey);
    expect(authorizeNetTransactionEvents({ ...t, settleAmount: 1 }, ctx, RECEIVED)[0]!.idempotencyKey).toBe(settled.idempotencyKey);
    expect(settled.id).toBe(`authorize_net_transaction:${String(t.transId)}:settledSuccessfully`);
  });

  it("maps every status Authorize.net lists, and keeps one it doesn't know as unknown", () => {
    const of = (transactionStatus: string) => authorizeNetTransactionEvents({ transId: "1", submitTimeUTC: "2026-01-01T00:00:00Z", transactionStatus }, { currency: "USD" }, RECEIVED)[0]!;
    const charges = { succeeded: ["settledSuccessfully", "capturedPendingSettlement", "couldNotVoid"], pending: ["authorizedPendingCapture", "authorizedPendingRelease", "pendingSettlement", "pendingFinalSettlement", "updatingSettlement", "underReview", "approvedReview", "FDSPendingReview", "FDSAuthorizedPendingReview"], failed: ["declined", "expired", "failedReview", "generalError", "communicationError", "settlementError", "voided"] };
    for (const [status, list] of Object.entries(charges)) for (const s of list) expect([s, of(s).type, of(s).payload.status]).toEqual([s, "payment.charge_updated", status]);
    expect([of("refundPendingSettlement").type, of("refundPendingSettlement").payload.status]).toEqual(["payment.refund_updated", "pending"]);
    expect(of("chargebackReversal").payload).toMatchObject({ reason: "chargeback", status: "funds_reinstated" });
    expect(of("returnedItem").payload).toMatchObject({ reason: "returned_item", status: "funds_withdrawn" });
    expect(of("returnedItem").payload).not.toHaveProperty("chargeId");
    expect(of("newStatus").payload).toMatchObject({ status: "unknown", gatewayStatus: "newStatus", paid: false });
    expect(of("bad status!").idempotencyKey).toBe("authorize_net:transaction:1:unknown");
    expect(of("constructor").payload).toMatchObject({ status: "unknown" });
  });

  it("names card brands as Stripe does, and keeps nothing of a bank account", () => {
    expect(["Visa", "MasterCard", "AmericanExpress", "Discover", "JCB", "DinersClub", "ChinaUnionPay", "eCheck", "PayPal", "", undefined, "###"].map((a) => authorizeNetMethod(a))).toEqual([
      { method: "card", cardBrand: "visa" },
      { method: "card", cardBrand: "mastercard" },
      { method: "card", cardBrand: "amex" },
      { method: "card", cardBrand: "discover" },
      { method: "card", cardBrand: "jcb" },
      { method: "card", cardBrand: "diners" },
      { method: "card", cardBrand: "chinaunionpay" },
      { method: "other", cardBrand: null },
      { method: "other", cardBrand: null },
      { method: "other", cardBrand: null },
      { method: "other", cardBrand: null },
      { method: "card", cardBrand: null },
    ]);
  });

  it("reads amounts, times and lists in the shapes the JSON API may use, and dead-letters anything else", () => {
    expect([authorizeNetCents(10.005), authorizeNetCents("45.50"), authorizeNetCents(" 3 "), authorizeNetCents("-0.1"), authorizeNetCents("1e5"), authorizeNetCents(Number.NaN), authorizeNetCents(null)]).toEqual([1001, 4550, 300, -10, null, null, null]);
    expect(authorizeNetTime("2026-01-05T08:00:00Z")).toBe("2026-01-05T08:00:00.000Z");
    expect(authorizeNetTime("2026-01-05T08:00:00")).toBe("2026-01-05T08:00:00.000Z");
    expect(authorizeNetTime("2026-01-05T08:00:00.1234567")).toBe("2026-01-05T08:00:00.123Z");
    expect(authorizeNetTime("2026-01-05T08:00:00-07:00")).toBe("2026-01-05T15:00:00.000Z");
    for (const bad of ["2026-13-45T00:00:00", "soon", "2026-01-05", 5, undefined, ""]) expect(authorizeNetTime(bad)).toBeUndefined();
    expect(authorizeNetList([{ a: 1 }, null, 5], "batch")).toEqual([{ a: 1 }]);
    expect(authorizeNetList({ batch: [{ a: 1 }] }, "batch")).toEqual([{ a: 1 }]);
    expect([authorizeNetList(undefined, "batch"), authorizeNetList({ batch: 5 }, "batch"), authorizeNetList("x", "batch")]).toEqual([[], [], []]);
  });

  it("drops records with no usable id, and keeps batch amounts it can't read as null", () => {
    expect(authorizeNetTransactionEvents({ transId: "../1" }, { currency: "USD" }, RECEIVED)).toEqual([]);
    expect(authorizeNetTransactionEvents(null as never, { currency: "USD" }, RECEIVED)).toEqual([]);
    expect(authorizeNetBatchEvents({ batchId: 7 as never }, "USD", RECEIVED)).toEqual([]);
    expect(authorizeNetBatchEvents(null as never, "USD", RECEIVED)).toEqual([]);
    expect(authorizeNetBatchEvents({ batchId: "7" }, "USD", RECEIVED)[0]).toMatchObject({
      occurredAt: undefined,
      idempotencyKey: "authorize_net:batch:7:unknown",
      payload: { amountCents: null, chargeCents: null, status: "unknown", method: "other", settledOn: null, chargeCount: 0 },
    });
    const wrapped = authorizeNetBatchEvents({ batchId: "7", settlementState: "settlementError", paymentMethod: "payPal", statistics: { statistic: [{ chargeAmount: "10.00", chargeCount: "2", refundCount: "x" }] } }, "USD", RECEIVED)[0]!;
    expect(wrapped.payload).toMatchObject({ amountCents: 1000, chargeCents: 1000, refundCents: null, chargeCount: 2, refundCount: 0, status: "failed", method: "paypal" });
    expect(authorizeNetBatchEvents({ batchId: "7", statistics: [{ refundAmount: 4 }] }, "USD", RECEIVED)[0]!.payload.amountCents).toBe(-400);
  });

  it("uses synthetic fixtures only", () => {
    expect(() => assertSynthetic(merchant())).not.toThrow();
  });
});

describe("Authorize.net sync", () => {
  const WINDOWS = Math.ceil((Date.parse("2026-01-20T00:00:00Z") - Date.parse("2021-01-20T00:00:00Z")) / (31 * DAY));

  it("imports, replays, resumes and retries the mocked account", async () => {
    // 3 settlement batches, one in the first window so the resume check has something before its crash;
    // 6 settled transactions, one dead-lettered; 2 unsettled.
    const data = merchant();
    data.batches.unshift(authorizeNetBatch.one({ batchId: authorizeNetBatchId(50), settlementTimeUTC: "2021-01-25T03:00:00Z" }));
    const result = await checkConnectorSync({ makeConnector: () => connector(authorizeNetDocMock(data)), expected: { ingested: 10, deadLettered: 1 } });
    expect(WINDOWS).toBe(59);
    // One batch per window, one per settled batch's page of transactions, one for the unsettled.
    expect(result.full.batches).toBe(WINDOWS + 3 + 1);
    expect(parseAuthorizeNetCursor(result.full.cursor)).toEqual({
      pass: "historical",
      step: "done",
      windowStart: "2025-12-23T00:00:00.000Z",
      until: RECEIVED,
      batches: [],
      page: 1,
      nextFrom: "2026-01-19T23:00:00.000Z",
    });
  });

  it("walks settled batches five years back in 31-day windows, then each batch's transactions, then the unsettled ones", async () => {
    const mock = authorizeNetDocMock(merchant());
    const { fetch, sent } = recording(mock);
    await runSync({ connector: connector(mock, { fetch }), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    expect(sent.every((s) => s.url === AUTHORIZE_NET_API_URLS.sandbox)).toBe(true);
    expect(sent[0]!.type).toBe("getMerchantDetailsRequest");
    const windows = sent.filter((s) => s.type === "getSettledBatchListRequest").map((s) => s.fields);
    expect(windows).toHaveLength(WINDOWS);
    expect(windows[0]).toEqual({ includeStatistics: "true", firstSettlementDate: "2021-01-20T00:00:00Z", lastSettlementDate: "2021-02-20T00:00:00Z" });
    expect(windows.at(-1)).toEqual({ includeStatistics: "true", firstSettlementDate: "2025-12-23T00:00:00Z", lastSettlementDate: "2026-01-20T00:00:00Z" });
    windows.forEach((w, i) => {
      expect(Date.parse(String(w.lastSettlementDate)) - Date.parse(String(w.firstSettlementDate))).toBeLessThanOrEqual(31 * DAY);
      if (i > 0) expect(w.firstSettlementDate).toBe(windows[i - 1]!.lastSettlementDate);
    });
    expect(sent.slice(WINDOWS + 1).map((s) => [s.type, s.fields.batchId ?? s.fields.transId ?? null])).toEqual([
      ["getTransactionListRequest", authorizeNetBatchId(1)],
      ["getTransactionDetailsRequest", authorizeNetTransId(3)],
      ["getTransactionListRequest", authorizeNetBatchId(2)],
      ["getTransactionDetailsRequest", authorizeNetTransId(5)],
      ["getUnsettledTransactionListRequest", null],
    ]);
    expect(sent.find((s) => s.type === "getTransactionListRequest")!.fields).toEqual({ batchId: authorizeNetBatchId(1), sorting: { orderBy: "id", orderDescending: "false" }, paging: { limit: "1000", offset: "1" } });
  });

  it("pages every list 1000 at a time to the end", async () => {
    const data = merchant();
    authorizeNetTransaction.reset();
    data.transactions![authorizeNetBatchId(1)] = authorizeNetTransaction.many(2001);
    data.unsettled = authorizeNetTransaction.many(1001, (n) => ({ transId: authorizeNetTransId(5000 + n), transactionStatus: "authorizedPendingCapture" }));
    const mock = authorizeNetDocMock(data);
    const { fetch, sent } = recording(mock);
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "historical", ...testPipeline(), organizationId: TEST_ORG });
    const offsets = (type: string, batchId?: string) => sent.filter((s) => s.type === type && s.fields.batchId === batchId).map((s) => (s.fields.paging as { offset: string }).offset);
    expect(offsets("getTransactionListRequest", authorizeNetBatchId(1))).toEqual(["1", "2", "3"]);
    expect(offsets("getUnsettledTransactionListRequest")).toEqual(["1", "2"]);
    expect(report.ingested).toBe(2 + 2001 + 2 + 1001 - 1);
  });

  it("goes by a full page when a list gives no total", async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ transId: String(from + i), submitTimeUTC: "2026-01-01T00:00:00Z", transactionStatus: "authorizedPendingCapture" }));
    const client = stubClient((type, fields) => {
      if (type === "getMerchantDetailsRequest") return { currencies: { currency: ["EUR"] }, messages: OK };
      const offset = (fields.paging as { offset: number }).offset;
      return { transactions: offset === 1 ? page(1000, 1) : page(3, 5000), messages: OK };
    });
    const cursor: AuthorizeNetCursor = { pass: "incremental", step: "unsettled", windowStart: RECEIVED, until: RECEIVED, batches: [], page: 1, nextFrom: RECEIVED };
    const batches = [];
    for await (const b of authorizeNetConnector({ ...options(authorizeNetDocMock(merchant())), client }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(cursor) })) batches.push(b);
    expect(batches.map((b) => b.events.length)).toEqual([1000, 3]);
    expect((batches[0]!.events[0] as { payload: Record<string, unknown> }).payload.currency).toBe("EUR");
  });

  it("stops when the merchant details name no currency, rather than guess one", async () => {
    for (const currencies of [[], ["usd"], undefined]) {
      const client = stubClient(() => ({ currencies, messages: OK }));
      const c = authorizeNetConnector({ ...options(authorizeNetDocMock(merchant())), client });
      await expect(runSync({ connector: c, mode: "historical", ...testPipeline(), organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow("Authorize.net's merchant details name no currency");
    }
  });

  it("produces payloads the retail departments accept", async () => {
    const memory = new InMemoryStore();
    const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
    const report = await runSync({ connector: connector(authorizeNetDocMock(merchant())), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 9, deadLettered: 1 });
    expect(memory.events.map((e) => e.type).sort()).toEqual([
      "payment.charge_updated", "payment.charge_updated", "payment.charge_updated", "payment.charge_updated", "payment.charge_updated",
      "payment.dispute_updated", "payment.refund_updated", "payout.updated", "payout.updated",
    ]);
  });

  it("leaves a finished import finished, without a call", async () => {
    const done: AuthorizeNetCursor = { pass: "historical", step: "done", windowStart: RECEIVED, until: RECEIVED, batches: [], page: 1, nextFrom: RECEIVED };
    const mock = authorizeNetDocMock(merchant());
    const batches = [];
    for await (const b of connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(done) })) batches.push(b);
    expect([batches, mock.fetch.calls]).toEqual([[], []]);
  });

  it("reads from where the last pass started, less an hour, and starts the next pass an hour before this one", async () => {
    const mock = authorizeNetDocMock(merchant());
    const { fetch, sent } = recording(mock);
    const previous: AuthorizeNetCursor = { pass: "incremental", step: "done", windowStart: "2026-01-01T00:00:00.000Z", until: "2026-01-02T03:30:00.000Z", batches: [], page: 1, nextFrom: "2026-01-02T02:30:00.000Z" };
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "authorize_net", "incremental", JSON.stringify(previous));
    const report = await runSync({ connector: connector(mock, { fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(sent.filter((s) => s.type === "getSettledBatchListRequest").map((s) => s.fields.firstSettlementDate)).toEqual(["2026-01-02T02:30:00Z"]);
    expect(report).toMatchObject({ ingested: 9, deadLettered: 1 });
    expect(AUTHORIZE_NET_OVERLAP_MS).toBe(3_600_000);
    expect(parseAuthorizeNetCursor(report.cursor)).toEqual({ pass: "incremental", step: "done", windowStart: "2026-01-02T02:30:00.000Z", until: RECEIVED, batches: [], page: 1, nextFrom: "2026-01-19T23:00:00.000Z" });
  });

  it("catches a batch that settles while a pass runs, on the next pass", async () => {
    const data = merchant({ unsettled: [] });
    const late = authorizeNetBatch.one({ batchId: authorizeNetBatchId(99), settlementTimeUTC: "2026-01-19T23:40:00Z" });
    const { memory, pipeline } = testPipeline();
    // Authorize.net lists the batch a little after its settlement time, so the pass at midnight doesn't see it.
    await runSync({ connector: connector(authorizeNetDocMock(data)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const later = () => new Date(NOW().getTime() + 15 * 60_000);
    const next = await runSync({ connector: connector(authorizeNetDocMock({ ...data, batches: [...data.batches, late] }), { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(memory.events.filter((e) => e.type === "payout.updated").map((e) => e.payload.payoutId)).toContain(`authorize_net:batch:${authorizeNetBatchId(99)}`);
    expect(next.ingested).toBe(1);
  });

  it("looks back 48 hours with no checkpoint, and reads unsettled transactions again on every pass", async () => {
    const data = merchant();
    const { fetch, sent } = recording(authorizeNetDocMock(data));
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(authorizeNetDocMock(data), { fetch }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(sent.find((s) => s.type === "getSettledBatchListRequest")!.fields.firstSettlementDate).toBe("2026-01-18T00:00:00Z");
    expect(first.ingested).toBe(2);
    // The authorization is captured: the same transaction comes back with a new status, stored once more.
    const moved = { ...data, unsettled: [{ ...data.unsettled![0]!, transactionStatus: "capturedPendingSettlement" }, data.unsettled![1]!] };
    const second = await runSync({ connector: connector(authorizeNetDocMock(moved)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(second).toMatchObject({ ingested: 1, duplicates: 1 });
    const third = await runSync({ connector: connector(authorizeNetDocMock(moved)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(third).toMatchObject({ ingested: 0, duplicates: 2 });
  });

  it("resumes an interrupted pass at the batch and page it stopped on", async () => {
    const mock = authorizeNetDocMock(merchant());
    const { fetch, sent } = recording(mock);
    const stopped: AuthorizeNetCursor = { pass: "historical", step: "transactions", windowStart: "2025-12-23T00:00:00.000Z", until: RECEIVED, batches: [authorizeNetBatchId(2)], page: 1, nextFrom: "2026-01-19T23:00:00.000Z" };
    const batches = [];
    for await (const b of connector(mock, { fetch }).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(stopped) })) batches.push(b);
    expect(sent.map((s) => s.type)).toEqual(["getMerchantDetailsRequest", "getTransactionListRequest", "getTransactionDetailsRequest", "getUnsettledTransactionListRequest"]);
    expect(sent[1]!.fields.batchId).toBe(authorizeNetBatchId(2));
    expect(batches).toHaveLength(2);
  });

  it("rejects a checkpoint it didn't write", () => {
    const good: AuthorizeNetCursor = { pass: "incremental", step: "transactions", windowStart: "2026-01-01T00:00:00.000Z", until: RECEIVED, batches: ["1", "2"], page: 2, nextFrom: "2026-01-19T23:00:00.000Z" };
    expect(parseAuthorizeNetCursor(JSON.stringify(good))).toEqual(good);
    expect(parseAuthorizeNetCursor(null)).toBeNull();
    for (const bad of [
      { ...good, pass: "full" },
      { ...good, step: "refunds" },
      { ...good, page: 0 },
      { ...good, page: 1.5 },
      { ...good, page: 100_001 },
      { ...good, windowStart: "2026-01-01" },
      { ...good, until: "2026-13-45T00:00:00Z" },
      { ...good, nextFrom: "Mon, 19 Jan 2026 00:00:00 GMT" },
      { ...good, windowStart: "2026-02-01T00:00:00.000Z" },
      { ...good, batches: "1" },
      { ...good, batches: ["1 OR 1=1"] },
      { ...good, batches: [1] },
      { ...good, batches: Array.from({ length: 1001 }, (_, i) => String(i)) },
      { ...good, batches: [] },
      { ...good, step: "batches" },
      null,
    ]) {
      expect(() => parseAuthorizeNetCursor(JSON.stringify(bad)), JSON.stringify(bad)?.slice(0, 80)).toThrow("Authorize.net checkpoint is not in the expected shape");
    }
  });

  it("writes dates as Authorize.net takes them", () => {
    expect(authorizeNetDate("2021-01-20T00:00:00.000Z")).toBe("2021-01-20T00:00:00Z");
  });

  it("declares its writes and a read-only gate refuses every one", async () => {
    const c = connector(authorizeNetDocMock(merchant()));
    expect(c.writes).toBe(AUTHORIZE_NET_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["refund_transaction", "refused"],
      ["void_transaction", "refused"],
    ]);
  });
});

describe("Authorize.net webhooks", () => {
  // A Signature Key is 128 hex characters; it is used as text, not decoded.
  const KEY_TEXT = ["ABCDEF", "0".repeat(122)].join("");
  const body = JSON.stringify({
    notificationId: "00000000-0000-4000-8000-000000000001",
    eventType: "net.authorize.payment.refund.created",
    eventDate: "2026-01-19T12:00:00.0000000Z",
    webhookId: "00000000-0000-4000-8000-000000000002",
    payload: { responseCode: 1, authCode: "000000", avsResponse: "Y", authAmount: 100, entityName: "transaction", id: authorizeNetTransId(3) },
  });
  const sign = (key: string | Buffer, text: string) => `sha512=${createHmac("sha512", key).update(text, "utf8").digest("hex").toUpperCase()}`;

  it("accepts a correctly signed delivery and rejects tampered, unsigned, wrongly keyed or malformed ones", () => {
    const signature = sign(KEY_TEXT, body);
    expect(verifyAuthorizeNetWebhook(KEY_TEXT, body, signature)).toEqual({ ok: true });
    expect(verifyAuthorizeNetWebhook(KEY_TEXT, Buffer.from(body), ` ${signature.toLowerCase()} `)).toEqual({ ok: true });
    expect(verifyAuthorizeNetWebhook(KEY_TEXT, tamper(body), signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAuthorizeNetWebhook(`${KEY_TEXT}0`, body, signature)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAuthorizeNetWebhook(KEY_TEXT, body, sign(Buffer.from(KEY_TEXT, "hex"), body))).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyAuthorizeNetWebhook(KEY_TEXT, body, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(verifyAuthorizeNetWebhook("", body, signature)).toEqual({ ok: false, reason: "missing" });
    const hex = signature.slice("sha512=".length);
    for (const malformed of [hex, `sha256=${hex}`, `sha512:${hex}`, `sha512=${hex.slice(2)}`, `sha512=${hex}00`, `sha512=${"Z".repeat(128)}`, `sha512=${Buffer.from(hex, "hex").toString("base64")}`, `x sha512=${hex}`]) {
      expect(verifyAuthorizeNetWebhook(KEY_TEXT, body, malformed), malformed.slice(0, 12)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("names the transaction a payment event is about, and nothing else", () => {
    expect(authorizeNetWebhookChange(JSON.parse(body))).toEqual({ eventType: "net.authorize.payment.refund.created", transactionId: authorizeNetTransId(3), time: "2026-01-19T12:00:00.0000000Z" });
    const event = JSON.parse(body) as { eventType: string; eventDate?: string; payload: Record<string, unknown> };
    expect(authorizeNetWebhookChange({ ...event, eventDate: undefined })!.time).toBeUndefined();
    for (const type of AUTHORIZE_NET_WEBHOOK_EVENTS) expect(authorizeNetWebhookChange({ ...event, eventType: type })!.eventType).toBe(type);
    expect(authorizeNetWebhookChange({ ...event, eventType: "net.authorize.payment.fraud.held" })).toBeNull();
    expect(authorizeNetWebhookChange({ ...event, eventType: "net.authorize.customer.created", payload: { ...event.payload, entityName: "customerProfile" } })).toBeNull();
    expect(authorizeNetWebhookChange({ ...event, payload: { ...event.payload, entityName: "customerProfile" } })).toBeNull();
    expect(authorizeNetWebhookChange({ ...event, payload: { ...event.payload, id: "../1" } })).toBeNull();
    expect(authorizeNetWebhookChange({ ...event, payload: { ...event.payload, id: 5 } })).toBeNull();
    expect([authorizeNetWebhookChange(null), authorizeNetWebhookChange([]), authorizeNetWebhookChange({ eventType: event.eventType })]).toEqual([null, null, null]);
  });

  it("treats a replayed delivery as a prompt to sync, which stores nothing twice", async () => {
    const { memory, pipeline } = testPipeline();
    const first = await runSync({ connector: connector(authorizeNetDocMock(merchant())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const again = await runSync({ connector: connector(authorizeNetDocMock(merchant())), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first.ingested).toBeGreaterThan(0);
    expect(again.ingested).toBe(0);
  });
});
