import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { AFTERPAY_DOC_PAGES, TEST_ORG, UndocumentedRequestError, afterpayDocMock, afterpayPayment, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline, type AfterpayMock, type AfterpayMockData } from "@karatos/connector-testkit";
import {
  AFTERPAY_API_HOSTS,
  AFTERPAY_PAGE_SIZE,
  AFTERPAY_PAYMENTS_PATH,
  AFTERPAY_REVISIT_DAYS,
  AFTERPAY_USER_AGENT,
  AFTERPAY_WRITES,
  AfterpayApiError,
  AfterpayConfigError,
  afterpayClient,
  afterpayConnector,
  afterpayMoney,
  afterpayPaymentEvents,
  afterpayTime,
  parseAfterpayCursor,
  type AfterpayClient,
  type AfterpayCursor,
  type AfterpayEvent,
  type AfterpayOptions,
} from "../src/index.js";

// A credential-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const SECRET = ["sk", "t".repeat(20)].join("-");
const MERCHANT = "600032000";
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const SANDBOX = `${AFTERPAY_API_HOSTS.sandbox}${AFTERPAY_PAYMENTS_PATH}`;
const BASIC = `Basic ${Buffer.from(`${MERCHANT}:${SECRET}`).toString("base64")}`;
const noSleep = async () => {};
const hours = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000).toISOString();
const base = () => ({ merchantId: MERCHANT, secretKey: SECRET, environment: "sandbox" });

function account(overrides: Partial<AfterpayMockData> = {}): AfterpayMockData {
  afterpayPayment.reset();
  return { merchantId: MERCHANT, secretKey: SECRET, payments: afterpayPayment.many(3), ...overrides };
}
const connector = (mock: AfterpayMock, overrides: Partial<AfterpayOptions> = {}) => afterpayConnector({ ...base(), fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as AfterpayEvent[];
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
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const page = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", offset: 0 };
const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => {
  const slept: number[] = [];
  const c = afterpayClient({ ...base(), fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const payment = (over: Record<string, unknown> = {}) => {
  afterpayPayment.reset();
  return { ...afterpayPayment.one(), ...over };
};

describe("Afterpay client", () => {
  it("checks its settings before sending anything", () => {
    for (const merchantId of ["", "a b", "m".repeat(65), undefined as unknown as string]) expect(() => afterpayClient({ ...base(), merchantId }), String(merchantId)).toThrow(new AfterpayConfigError("AFTERPAY_MERCHANT_ID must be the Merchant ID Afterpay gave"));
    for (const secretKey of ["", "short", "s".repeat(7), "has space here", "s".repeat(257), undefined as unknown as string]) expect(() => afterpayClient({ ...base(), secretKey }), String(secretKey)).toThrow(new AfterpayConfigError("set AFTERPAY_SECRET_KEY to the Secret Key Afterpay gave"));
    for (const environment of ["", "live", "Sandbox", undefined as unknown as string]) expect(() => afterpayClient({ ...base(), environment }), String(environment)).toThrow(new AfterpayConfigError("AFTERPAY_ENVIRONMENT must be production or sandbox"));
    expect(afterpayClient({ ...base(), merchantId: ` ${"m".repeat(64)} `, secretKey: ` ${"s".repeat(256)} `, environment: " production " }).environment).toBe("production");
    expect(afterpayClient({ ...base(), secretKey: "s".repeat(8) }).environment).toBe("sandbox");
    expect(new AfterpayConfigError("x").name).toBe("AfterpayConfigError");
    expect(new AfterpayApiError("x", 500, "c")).toMatchObject({ name: "AfterpayApiError", status: 500, code: "c" });
  });

  it("sends one GET of List Payments, oldest first, with Basic auth and a User-Agent", async () => {
    const { fetch, sent } = scripted([json(200, { results: [] })]);
    await client(fetch).c.payments({ ...page, offset: 500 });
    await client(fetch, { environment: "production", merchantId: ` ${MERCHANT}`, secretKey: `${SECRET} ` }).c.payments(page);
    const query = "fromCreatedDate=2026-01-01T00%3A00%3A00.000Z&toCreatedDate=2026-02-01T00%3A00%3A00.000Z&orderBy=createdAt&ascending=true&limit=250";
    expect(sent).toEqual([
      { url: `${SANDBOX}?${query}&offset=500`, method: "GET", headers: { accept: "application/json", authorization: BASIC, "user-agent": AFTERPAY_USER_AGENT } },
      { url: `https://global-api.afterpay.com/v2/payments?${query}&offset=0`, method: "GET", headers: { accept: "application/json", authorization: BASIC, "user-agent": AFTERPAY_USER_AGENT } },
    ]);
    expect(AFTERPAY_PAGE_SIZE).toBe(250);
    expect(AFTERPAY_USER_AGENT).toMatch(/^KaratOS\/1\.0 /);
  });

  it("refuses a window or offset it wasn't made for, before sending anything", async () => {
    const { fetch, sent } = scripted([json(200, {})]);
    const { c } = client(fetch);
    for (const [from, to] of [
      ["2026-01-01T00:00:00Z", page.to],
      [page.from, "2026-02-30T00:00:00.000Z"],
      [page.to, page.from],
      ["x", page.to],
      [5, page.to],
    ]) {
      await expect(c.payments({ from: from as string, to: to as string, offset: 0 }), `${from} ${to}`).rejects.toThrow(new AfterpayApiError("payments need a from time on or before a to time", 0));
    }
    for (const offset of [-1, 1.5, Number.NaN]) await expect(c.payments({ ...page, offset }), String(offset)).rejects.toThrow(new AfterpayApiError("a page offset must be a whole number from 0", 0));
    expect(sent).toHaveLength(0);
    await c.payments({ from: page.from, to: page.from, offset: 0 });
    expect(sent).toHaveLength(1);
  });

  it("explains a pair Afterpay turns down, and other answers", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.payments(page);
    await expect(at(json(401, { errorCode: "unauthorized", errorId: "e1", message: "Credentials are required to access this resource.", httpStatusCode: 401 }))).rejects.toThrow(
      new AfterpayConfigError("Afterpay turned down the Merchant ID and Secret Key (HTTP 401) (unauthorized): Credentials are required to access this resource.; check they are the sandbox pair"),
    );
    await expect(at(json(403, {}))).rejects.toThrow(/^Afterpay turned down the Merchant ID and Secret Key \(HTTP 403\); check/);
    await expect(at(json(422, { errorCode: "invalid_object", message: "m".repeat(250) }))).rejects.toThrow(new AfterpayApiError(`Afterpay answered HTTP 422 for the payments (invalid_object): ${"m".repeat(200)}`, 422, "invalid_object"));
    await expect(at(json(422, { errorCode: "Bad Code", message: 5 }))).rejects.toThrow(/^Afterpay answered HTTP 422 for the payments$/);
    await expect(at(json(422, { errorCode: "c".repeat(65) }))).rejects.toMatchObject({ code: undefined });
    await expect(at(json(201, {}))).rejects.toMatchObject({ status: 201 });
    await expect(at(json(500, null))).rejects.toThrow(/^Afterpay answered HTTP 500 for the payments$/);
    for (const body of [null, [], 5]) await expect(at(json(200, body)), JSON.stringify(body)).rejects.toThrow(new AfterpayApiError("Afterpay answered the payments without JSON", 200));
    await expect(at(() => new Response("{", { status: 200 }))).rejects.toThrow("without JSON");
  });

  it("waits out a 429 or 5xx as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (headers: Record<string, string>, status = 429) => {
      const { fetch, sent } = scripted([json(status, {}, headers), json(200, {})]);
      const { c, slept } = client(fetch);
      await c.payments(page);
      expect(sent).toHaveLength(2);
      return slept;
    };
    expect(await waits({ "retry-after": "2" })).toEqual([2000]);
    expect(await waits({ "retry-after": "60" })).toEqual([60_000]);
    expect(await waits({ "retry-after": "61" })).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits({ "retry-after": value }), value).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits({ "retry-after": "3" }, status), String(status)).toEqual([3000]);
    const { fetch, sent } = scripted([json(503, {})]);
    const { c, slept } = client(fetch);
    await expect(c.payments(page)).rejects.toMatchObject({ status: 503 });
    expect([sent.length, slept]).toEqual([4, [1000, 2000, 4000]]);
    const once = scripted([json(501, {})]);
    await expect(client(once.fetch).c.payments(page)).rejects.toMatchObject({ status: 501 });
    expect(once.sent).toHaveLength(1);
    const one = scripted([json(429, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.payments(page)).rejects.toMatchObject({ status: 429 });
    expect(one.sent).toHaveLength(2);
  });

  it("works with the default sleep and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([json(429, {}, { "retry-after": "0" }), json(200, {})]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await afterpayClient(base()).payments(page);
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("Afterpay events", () => {
  it("reads money and times as Afterpay writes them", () => {
    expect(afterpayMoney({ amount: "29.99", currency: "USD" })).toEqual({ cents: 2999, currency: "USD" });
    expect(afterpayMoney({ amount: "29.9", currency: "USD" })).toEqual({ cents: 2990, currency: "USD" });
    expect(afterpayMoney({ amount: "29", currency: "AUD" })).toEqual({ cents: 2900, currency: "AUD" });
    expect(afterpayMoney({ amount: "0.05", currency: "USD" })).toEqual({ cents: 5, currency: "USD" });
    expect(afterpayMoney({ amount: "9999999999999.99", currency: "USD" })).toEqual({ cents: 999_999_999_999_999, currency: "USD" });
    for (const m of [null, [], { amount: 29.99, currency: "USD" }, { amount: "29.999", currency: "USD" }, { amount: "-1.00", currency: "USD" }, { amount: "01.00", currency: "USD" }, { amount: "10000000000000", currency: "USD" }, { amount: "1.", currency: "USD" }, { amount: "1.00", currency: "usd" }, { amount: "1.00" }, { amount: " 1.00", currency: "USD" }]) {
      expect(afterpayMoney(m), JSON.stringify(m)).toBeUndefined();
    }
    expect(afterpayTime("2026-01-01T05:00:00.123456789Z")).toBe("2026-01-01T05:00:00.123Z");
    expect(afterpayTime("2026-01-01T05:00Z")).toBe("2026-01-01T05:00:00.000Z");
    expect(afterpayTime("2026-01-01T05:00:00+10:00")).toBe("2025-12-31T19:00:00.000Z");
    for (const t of ["2026-01-01", "2026-01-01T05:00:00", "x2026-01-01T05:00:00Z", "2026-01-01T05:00:00Zx", "2026-02-30T00:00:00Z".replace("02-30", "13-01"), 5]) expect(afterpayTime(t), String(t)).toBeUndefined();
  });

  it("reads a payment as a charge, without the shopper's details or the items", () => {
    const [charge, ...rest] = afterpayPaymentEvents(payment(), RECEIVED);
    expect(rest).toEqual([]);
    expect(charge!.ok).toBe(true);
    expect(charge!.event).toEqual({
      id: "afterpay_payment_100101_captured_10000_0",
      type: "payment.charge_updated",
      occurredAt: hours(1),
      receivedAt: RECEIVED,
      idempotencyKey: "afterpay:payment:100101:captured:10000:0",
      payload: { system: "Afterpay", chargeId: "afterpay:payment:100101", status: "succeeded", gatewayStatus: "captured", paid: true, captured: true, voided: false, amountCents: 10000, capturedCents: 10000, refundedCents: 0, currency: "USD", method: "financing", cardBrand: null, orderId: "ORDER-1" },
    });
    expect(JSON.stringify(charge)).not.toMatch(/Tester|example\.test|555-0100|Test ring|tok_1|SKU/);
  });

  it("maps each state, and keys each step once", () => {
    const states = ["AUTH_APPROVED", "PARTIALLY_CAPTURED", "CAPTURED", "AUTH_DECLINED", "CAPTURE_DECLINED", "VOIDED", "EXPIRED", "REVERSED"];
    const open = { amount: "40.00", currency: "USD" };
    const read = (over: Record<string, unknown>) => afterpayPaymentEvents(payment({ openToCaptureAmount: open, ...over }), RECEIVED)[0]!.event;
    expect(states.map((paymentState) => [paymentState, read({ paymentState }).payload.status, read({ paymentState }).payload.capturedCents, read({ paymentState }).payload.voided])).toEqual([
      ["AUTH_APPROVED", "pending", 0, false],
      ["PARTIALLY_CAPTURED", "succeeded", 6000, false],
      ["CAPTURED", "succeeded", 6000, false],
      ["AUTH_DECLINED", "failed", 0, false],
      ["CAPTURE_DECLINED", "failed", 0, false],
      ["VOIDED", "failed", 0, true],
      ["EXPIRED", "failed", 0, false],
      ["REVERSED", "failed", 0, false],
    ]);
    expect(read({ paymentState: "AUTH_APPROVED" }).payload).toMatchObject({ paid: false, captured: false, gatewayStatus: "auth_approved" });
    expect(read({ openToCaptureAmount: undefined }).payload.capturedCents).toBe(10000);
    expect(read({ status: "DECLINED", paymentState: undefined }).payload).toMatchObject({ status: "failed", gatewayStatus: "declined", paid: false });
    expect(read({ status: "DECLINED", paymentState: "CAPTURED" }).payload).toMatchObject({ status: "failed", gatewayStatus: "declined", paid: false, capturedCents: 6000 });
    expect(new Set(states.map((paymentState) => read({ paymentState }).idempotencyKey)).size).toBe(8);
    expect(read({ paymentState: "CAPTURED", openToCaptureAmount: { amount: "0.00", currency: "USD" } }).idempotencyKey).not.toBe(read({ paymentState: "CAPTURED" }).idempotencyKey);
    expect(read({ merchantReference: "Order #12/a.b:c_d-1 x" }).payload.orderId).toBe("Order #12/a.b:c_d-1 x");
    for (const merchantReference of ["o".repeat(86), "a<b", 5, ""]) expect(read({ merchantReference }).payload.orderId, String(merchantReference)).toBeUndefined();
    expect(read({ merchantReference: "o".repeat(85) }).payload.orderId).toBe("o".repeat(85));
    expect(read({ receivedAt: "x" }).idempotencyKey).toBe(afterpayPaymentEvents(payment({ openToCaptureAmount: open }), "2026-12-01T00:00:00.000Z")[0]!.event.idempotencyKey);
  });

  it("reads each refund, linked to its order, and counts it on the charge", () => {
    const refunds = [
      { refundId: "r-1", amount: { amount: "10.00", currency: "USD" }, refundedAt: hours(5), merchantReference: "RF-1", requestId: "q" },
      { refundId: "r-2", amount: { amount: "5.50", currency: "USD" }, refundedAt: hours(6) },
    ];
    const reads = afterpayPaymentEvents(payment({ refunds }), RECEIVED);
    expect(reads.map((r) => r.ok)).toEqual([true, true, true]);
    expect(reads[0]!.event.payload).toMatchObject({ refundedCents: 1550 });
    expect(reads[0]!.event.idempotencyKey).toBe("afterpay:payment:100101:captured:10000:1550");
    expect(reads[1]!.event).toEqual({
      id: "afterpay_refund_r-1",
      type: "payment.refund_updated",
      occurredAt: hours(5),
      receivedAt: RECEIVED,
      idempotencyKey: "afterpay:refund:r-1",
      payload: { system: "Afterpay", refundId: "afterpay:refund:r-1", chargeId: "afterpay:payment:100101", amountCents: 1000, currency: "USD", status: "succeeded", reason: null },
    });
    expect(reads[2]!.event.payload.amountCents).toBe(550);
    expect(afterpayPaymentEvents(payment({ refunds: "x" }), RECEIVED)).toHaveLength(1);
  });

  it("dead-letters a refund that doesn't read, and leaves it off the charge", () => {
    const problems = (refund: unknown) => {
      const reads = afterpayPaymentEvents(payment({ refunds: [refund] }), RECEIVED);
      expect(reads[0]!.event.payload.refundedCents).toBe(0);
      const r = reads[1]!;
      expect(r.event.occurredAt === undefined).toBe(!r.ok);
      return r.ok ? [] : (r.event.payload.problems as string[]);
    };
    const good = { refundId: "r-1", amount: { amount: "10.00", currency: "USD" }, refundedAt: hours(5) };
    expect(problems(null)).toEqual(["refund is not an object", "refund has no id that reads", "refund has no amount that reads", "refund has no time that reads"]);
    expect(problems([])).toContain("refund is not an object");
    expect(problems({ ...good, refundId: "a b" })).toEqual(["refund has no id that reads"]);
    expect(problems({ ...good, amount: { amount: "10.00", currency: "AUD" } })).toEqual(["refund is not in the payment's currency"]);
    expect(problems({ ...good, refundedAt: "soon" })).toEqual(["refund has no time that reads"]);
    const dead = afterpayPaymentEvents(payment({ refunds: [{ ...good, refundId: 5 }] }), RECEIVED)[1]!.event;
    expect(dead).toMatchObject({ type: "payment.refund_updated", idempotencyKey: expect.stringMatching(/^afterpay:unreadable_refund:[0-9a-f]{12}$/), payload: { system: "Afterpay", kind: "refund", problems: ["refund has no id that reads"] } });
    expect(dead.id).toBe(dead.idempotencyKey.replace(/:/g, "_"));
  });

  it("dead-letters a payment that doesn't read, without its refunds", () => {
    const problems = (raw: unknown) => {
      const reads = afterpayPaymentEvents(raw, RECEIVED);
      const r = reads[0]!;
      expect(r.event.occurredAt === undefined).toBe(!r.ok);
      if (!r.ok) expect(reads).toHaveLength(1);
      return r.ok ? [] : (r.event.payload.problems as string[]);
    };
    expect(problems(null)).toEqual(["payment is not an object", "payment has no id that reads", "payment has no amount that reads", "payment has no time that reads", "payment has no state that reads"]);
    expect(problems([])).toContain("payment is not an object");
    expect(problems(undefined)).toContain("payment is not an object");
    const refunds = [{ refundId: "r-1", amount: { amount: "10.00", currency: "USD" }, refundedAt: hours(5) }];
    expect(problems(payment({ id: "a b", refunds }))).toEqual(["payment has no id that reads"]);
    expect(problems(payment({ id: "i".repeat(65) }))).toEqual(["payment has no id that reads"]);
    expect(problems(payment({ id: "i".repeat(64) }))).toEqual([]);
    expect(problems(payment({ originalAmount: { amount: "x", currency: "USD" } }))).toEqual(["payment has no amount that reads"]);
    expect(problems(payment({ created: "2026-01-01" }))).toEqual(["payment has no time that reads"]);
    expect(problems(payment({ paymentState: "SETTLED" }))).toEqual(["payment has no state that reads"]);
    expect(problems(payment({ paymentState: "constructor" }))).toEqual(["payment has no state that reads"]);
    const dead = afterpayPaymentEvents(payment({ paymentState: 5 }), RECEIVED)[0]!.event;
    expect(dead).toMatchObject({ idempotencyKey: expect.stringMatching(/^afterpay:unreadable_payment:[0-9a-f]{12}$/), payload: { system: "Afterpay", kind: "payment", problems: ["payment has no state that reads"] } });
    expect(afterpayPaymentEvents(payment({ paymentState: 6 }), RECEIVED)[0]!.event.idempotencyKey).not.toBe(dead.idempotencyKey);
  });
});

describe("Afterpay connector", () => {
  it("passes the shared sync checks", async () => {
    await checkConnectorSync({ makeConnector: () => connector(afterpayDocMock(account())), expected: { ingested: 3 } });
  });

  it("imports five years of payments a full page at a time, oldest first, and stops for good", async () => {
    afterpayPayment.reset();
    const payments = afterpayPayment.many(AFTERPAY_PAGE_SIZE + 2);
    const old = payment({ id: "old-1", created: "2021-11-11T14:59:59.999Z" });
    const edge = payment({ id: "edge-1", created: "2021-11-11T15:00:00.000Z" });
    const mock = afterpayDocMock({ merchantId: MERCHANT, secretKey: SECRET, payments: [...payments, old, edge] });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: AFTERPAY_PAGE_SIZE + 3, deadLettered: 0 });
    expect(mock.reads).toEqual([
      { from: "2021-11-11T15:00:00.000Z", to: RECEIVED, offset: 0, limit: 250 },
      { from: "2021-11-11T15:00:00.000Z", to: RECEIVED, offset: 250, limit: 250 },
    ]);
    expect(memory.events[0]!.payload).toMatchObject({ chargeId: "afterpay:payment:edge-1" });
    assertSynthetic(memory.events.map((e) => e.payload));
    expect(JSON.parse(report.cursor!)).toEqual({ done: true, through: RECEIVED, pass: null });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect([again.ingested, mock.reads.length]).toEqual([0, 2]);
  });

  it("ends a window on a full last page once the total is reached", async () => {
    afterpayPayment.reset();
    const mock = afterpayDocMock({ merchantId: MERCHANT, secretKey: SECRET, payments: afterpayPayment.many(AFTERPAY_PAGE_SIZE) });
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect([batches.length, mock.reads.length]).toEqual([1, 1]);
    // A page that says nothing of the total, full, reads on until a short one.
    const pages = [Array.from({ length: AFTERPAY_PAGE_SIZE }, (_, i) => payment({ id: `p-${i}` })), []];
    const seen: number[] = [];
    const fake: AfterpayClient = { environment: "sandbox", payments: async ({ offset }) => (seen.push(offset), { results: pages[seen.length - 1] }) };
    const out = await drain(afterpayConnector({ ...base(), client: fake, now: NOW }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect([seen, eventsOf(out).length]).toEqual([[0, 250], 250]);
    expect(JSON.parse(out[0]!.cursor)).toEqual({ done: false, through: null, pass: { from: "2021-11-11T15:00:00.000Z", to: RECEIVED, offset: 250 } });
  });

  it("reads the last 60 days again on each later sync, storing only what changed", async () => {
    const recent = (n: number, over: Record<string, unknown> = {}) => payment({ id: `r-${n}`, created: new Date(Date.parse(RECEIVED) - n * 86_400_000).toISOString(), ...over });
    const state: AfterpayCursor = { done: true, through: "2026-11-10T15:00:00.000Z", pass: null };
    const first = afterpayDocMock({ merchantId: MERCHANT, secretKey: SECRET, payments: [recent(1), recent(59), recent(61)] });
    const { memory, pipeline } = testPipeline();
    await memory.saveCheckpoint(TEST_ORG, "afterpay", "incremental", JSON.stringify(state));
    const report = await runSync({ connector: connector(first), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(2);
    expect(first.reads).toEqual([{ from: "2026-09-12T15:00:00.000Z", to: RECEIVED, offset: 0, limit: 250 }]);
    expect(AFTERPAY_REVISIT_DAYS).toBe(60);
    const refunded = afterpayDocMock({ merchantId: MERCHANT, secretKey: SECRET, payments: [recent(1), recent(59, { refunds: [{ refundId: "x-1", amount: { amount: "1.00", currency: "USD" }, refundedAt: hours(7000) }] })] });
    const next = await runSync({ connector: connector(refunded), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect([next.ingested, next.duplicates]).toEqual([2, 1]);
    expect(JSON.parse(next.cursor!)).toEqual({ done: true, through: RECEIVED, pass: null });
  });

  it("reads back to the last finished sync when that was longer ago, and leaves the import to do", async () => {
    const mock = afterpayDocMock(account());
    const old: AfterpayCursor = { done: false, through: "2026-01-01T00:00:00.000Z", pass: null };
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(old) }));
    expect(mock.reads[0]!.from).toBe("2026-01-01T00:00:00.000Z");
    expect(JSON.parse(batches.at(-1)!.cursor)).toEqual({ done: false, through: RECEIVED, pass: null });
    const atEdge = afterpayDocMock(account());
    await drain(connector(atEdge).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ ...old, through: "2026-09-12T15:00:00.000Z" }) }));
    expect(atEdge.reads[0]!.from).toBe("2026-09-12T15:00:00.000Z");
    const none = afterpayDocMock(account());
    await drain(connector(none).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(none.reads[0]!.from).toBe("2026-09-12T15:00:00.000Z");
  });

  it("resumes a window at its saved offset", async () => {
    afterpayPayment.reset();
    const mock = afterpayDocMock({ merchantId: MERCHANT, secretKey: SECRET, payments: afterpayPayment.many(AFTERPAY_PAGE_SIZE + 1) });
    const saved: AfterpayCursor = { done: false, through: null, pass: { from: "2025-01-01T00:00:00.000Z", to: RECEIVED, offset: 250 } };
    const batches = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(mock.reads).toEqual([{ from: "2025-01-01T00:00:00.000Z", to: RECEIVED, offset: 250, limit: 250 }]);
    expect(eventsOf(batches)).toHaveLength(1);
  });

  it("resumes a later sync's window at its saved offset, keeping the import's place", async () => {
    afterpayPayment.reset();
    const mock = afterpayDocMock({ merchantId: MERCHANT, secretKey: SECRET, payments: afterpayPayment.many(AFTERPAY_PAGE_SIZE + 1) });
    const saved: AfterpayCursor = { done: true, through: "2024-12-31T00:00:00.000Z", pass: { from: "2025-01-01T00:00:00.000Z", to: RECEIVED, offset: 250 } };
    const batches = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(mock.reads).toEqual([{ from: "2025-01-01T00:00:00.000Z", to: RECEIVED, offset: 250, limit: 250 }]);
    expect(batches.map((b) => JSON.parse(b.cursor))).toEqual([{ done: true, through: RECEIVED, pass: null }]);
  });

  it("keeps a payment that doesn't read, as a dead letter", async () => {
    const mock = afterpayDocMock(account({ payments: [payment({ paymentState: "?" })] }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 1 });
  });

  it("stops on a pair meant for the other host, keeping no checkpoint", async () => {
    const mock = afterpayDocMock(account({ environment: "production" }));
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep })).rejects.toThrow(AfterpayConfigError);
    expect(await memory.getCheckpoint(TEST_ORG, "afterpay", "historical")).toBeNull();
    expect(mock.reads).toHaveLength(0);
  });

  it("checks its history, uses the real clock by default, and declares its write, refused", async () => {
    const mock = afterpayDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    const windows: string[] = [];
    const fake: AfterpayClient = { environment: "sandbox", payments: async ({ from, to }) => (windows.push(`${from}..${to}`), { results: [] }) };
    const before = Date.now();
    await drain(afterpayConnector({ ...base(), client: fake, historyYears: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    const [from, to] = windows[0]!.split("..");
    expect(Date.parse(to!)).toBeGreaterThanOrEqual(before);
    const yearBack = new Date(to!);
    yearBack.setUTCFullYear(yearBack.getUTCFullYear() - 1);
    expect(from).toBe(yearBack.toISOString());
    const c = connector(mock);
    expect(c.source).toBe("afterpay");
    expect(c.writes).toBe(AFTERPAY_WRITES);
    expect(AFTERPAY_WRITES).toEqual([{ integration: "afterpay", name: "refund_payment", description: "Refund an Afterpay order", kind: "update", approval: "each", dailyCap: 5 }]);
    expect(await assertWritesRefused(c)).toMatchObject([{ action: "refund_payment", integration: "afterpay", outcome: "refused" }]);
  });

  it("refuses a checkpoint that isn't its own", () => {
    const pass = { from: "2026-01-01T00:00:00.000Z", to: RECEIVED, offset: 250 };
    const good = { done: false, through: RECEIVED, pass };
    expect(parseAfterpayCursor(null)).toBeNull();
    expect(parseAfterpayCursor(JSON.stringify(good))).toEqual(good);
    expect(parseAfterpayCursor(JSON.stringify({ ...good, through: null, pass: null }))).toEqual({ done: false, through: null, pass: null });
    expect(parseAfterpayCursor(JSON.stringify({ ...good, pass: { ...pass, from: RECEIVED, offset: 0 } }))!.pass).toEqual({ from: RECEIVED, to: RECEIVED, offset: 0 });
    const bad: unknown[] = [
      "{",
      "null",
      { ...good, done: "true" },
      { ...good, through: "2026-01-01" },
      { ...good, through: undefined },
      { ...good, pass: undefined },
      { ...good, pass: { ...pass, from: "2026-01-01T00:00:00Z" } },
      { ...good, pass: { ...pass, to: "x" } },
      { ...good, pass: { ...pass, from: "2026-12-01T00:00:00.000Z" } },
      { ...good, pass: { ...pass, offset: -1 } },
      { ...good, pass: { ...pass, offset: 0.5 } },
      { ...good, pass: { ...pass, offset: "250" } },
    ];
    for (const raw of bad) expect(() => parseAfterpayCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("Afterpay checkpoint is not in the expected shape");
  });
});

describe("Afterpay doc mock", () => {
  const get = (mock: AfterpayMock, query = "", headers: Record<string, string> = { authorization: BASIC, "user-agent": "t" }, url = SANDBOX) => mock.fetch(`${url}${query}`, { headers });

  it("checks the pair, the host and the User-Agent", async () => {
    const mock = afterpayDocMock(account());
    expect((await get(mock, "", { authorization: `Basic ${Buffer.from(`${MERCHANT}:wrong-secret`).toString("base64")}`, "user-agent": "t" })).status).toBe(401);
    expect((await get(mock, "", { authorization: BASIC, "user-agent": "t" }, "https://global-api.afterpay.com/v2/payments")).status).toBe(401);
    expect((await get(mock, "", { authorization: BASIC })).status).toBe(400);
    const ok = await get(mock);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ totalResults: 3, offset: 0, limit: 20 });
  });

  it("filters, orders and pages as List Payments says", async () => {
    const mock = afterpayDocMock(account());
    const ids = async (query: string) => ((await (await get(mock, query)).json()) as { results: { id: string }[] }).results.map((p) => p.id);
    expect(await ids("")).toEqual(["100103", "100102", "100101"]);
    expect(await ids("?ascending=true")).toEqual(["100101", "100102", "100103"]);
    expect(await ids(`?ascending=true&limit=1&offset=1`)).toEqual(["100102"]);
    expect(await ids(`?fromCreatedDate=${hours(2)}&toCreatedDate=${hours(2)}`)).toEqual(["100102"]);
    for (const q of ["?limit=0", "?limit=251", "?offset=-1", "?orderBy=updatedAt", "?ascending=yes", "?fromCreatedDate=soon", "?toCreatedDate=2026", "?updatedSince=x"]) expect((await get(mock, q)).status, q).toBe(422);
    expect(await ids("?orderBy=amount&statuses=APPROVED&includeNextLink=true&tokens=a&ids=b&merchantReferences=c")).toHaveLength(3);
    expect(mock.reads.at(-1)).toEqual({ from: "", to: "", offset: 0, limit: 20 });
  });

  it("answers 429 with Retry-After, and refuses a look-alike host and anything the docs don't list", async () => {
    const mock = afterpayDocMock(account({ rateLimits: 1 }));
    const limited = await get(mock);
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "1"]);
    await expect(mock.fetch("https://global-api.afterpay.com.example.test/v2/payments", {})).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${SANDBOX}/100101/refund`, { method: "POST", body: "{}", headers: { authorization: BASIC } })).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(afterpayDocMock(account({ environment: "production" })).production.routes.map((r) => r.documentedAt)).toEqual([AFTERPAY_DOC_PAGES.listPayments]);
  });
});
