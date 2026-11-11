import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, klarnaDocMock, klarnaPayout, klarnaTransaction, testPipeline, type KlarnaMock, type KlarnaMockData } from "@karatos/connector-testkit";
import {
  KLARNA_API_URLS,
  KLARNA_OVERLAP_MS,
  KLARNA_PAYOUTS_PATH,
  KLARNA_PAYOUT_EVENT,
  KLARNA_PAYOUT_PAGE_SIZE,
  KLARNA_TRANSACTIONS_PATH,
  KLARNA_TRANSACTION_EVENT,
  KLARNA_TRANSACTION_PAGE_SIZE,
  KLARNA_WRITES,
  KlarnaApiError,
  KlarnaConfigError,
  klarnaAuthorization,
  klarnaClient,
  klarnaConnector,
  klarnaOrderRef,
  klarnaPaymentReference,
  klarnaPayoutEvent,
  klarnaPayoutRef,
  klarnaTime,
  klarnaTransactionEvent,
  parseKlarnaCursor,
  type KlarnaClient,
  type KlarnaEvent,
  type KlarnaOptions,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["klarna", "live", "api", "0".repeat(24)].join("_");
const TEST_KEY = ["klarna", "test", "api", "0".repeat(24)].join("_");
const USER = ["0".repeat(8), "0000", "4000", "8000", "0".repeat(12)].join("-");
const PASS = ["pw", "0".repeat(16)].join("_");
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const API = "https://api-na.klarna.com";
const noSleep = async () => {};

/** An ISO time `ago` days before NOW, as Klarna writes it. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString().replace(".000Z", "Z");

/** Payouts made 1, 30, 1,000 and 1,820 days ago, and six years ago, each with two lines. */
function account(overrides: Partial<KlarnaMockData> = {}): KlarnaMockData {
  klarnaPayout.reset();
  klarnaTransaction.reset();
  const payouts = [1, 30, 1000, 1820, 2200].map((d) => klarnaPayout.one({ payout_date: ago(d) }));
  const transactions = Object.fromEntries(payouts.map((p) => [String(p.payment_reference), [klarnaTransaction.one(), klarnaTransaction.one({ type: "FEE", detailed_type: "PURCHASE_FEE_PERCENTAGE", amount: -1_200 })]]));
  return { apiKey: KEY, payouts, transactions, ...overrides };
}

const connector = (mock: KlarnaMock, overrides: Partial<KlarnaOptions> = {}) => klarnaConnector({ apiKey: KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as KlarnaEvent[];

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
const PAYOUTS = (payouts: unknown[] = [], total?: number) => json(200, { payouts, pagination: { count: payouts.length, offset: 0, ...(total === undefined ? {} : { total }) } });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof klarnaClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = klarnaClient({ apiKey: KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const S = "2021-11-11T15:00:00.000Z";
const E = "2026-11-11T15:00:00.000Z";
const RANGE = { start: S, end: E, offset: 0 };

describe("Klarna client", () => {
  it("checks its credential, region and environment before sending anything", () => {
    const { fetch, sent } = scripted(PAYOUTS());
    const make = (o: Partial<Parameters<typeof klarnaClient>[0]>) => () => klarnaClient({ fetch, ...o });
    expect(make({})).toThrow(new KlarnaConfigError("KLARNA_API_KEY, or KLARNA_USERNAME and KLARNA_PASSWORD, is missing or not in the expected shape"));
    expect(make({ apiKey: "  " })).toThrow("KLARNA_API_KEY, or KLARNA_USERNAME and KLARNA_PASSWORD, is missing");
    for (const apiKey of ["klarna_live_api_short", "klarna_prod_api_000000000000", "klarna_live_key_000000000000", `x${KEY}`, `${KEY} `.repeat(2), `${KEY}!`, `klarna_live_api_${"0".repeat(201)}`]) expect(make({ apiKey }), apiKey).toThrow("KLARNA_API_KEY is not in the expected shape");
    expect(make({ apiKey: `klarna_live_api_${"0".repeat(200)}` })).not.toThrow();
    expect(make({ apiKey: `klarna_live_api_${"0".repeat(7)}` })).toThrow("KLARNA_API_KEY is not in the expected shape");
    expect(make({ apiKey: `klarna_live_api_${"0".repeat(8)}` })).not.toThrow();
    expect(make({ apiKey: "klarna_live_api_Ab9_-xyzw" })).not.toThrow();
    expect(make({ apiKey: KEY, username: USER })).toThrow("Set KLARNA_API_KEY or KLARNA_USERNAME and KLARNA_PASSWORD, not both");
    expect(make({ apiKey: KEY, password: PASS })).toThrow("not both");
    expect(make({ apiKey: KEY, username: " ", password: " " })).not.toThrow();
    expect(make({ apiKey: TEST_KEY })).toThrow("KLARNA_API_KEY is a test key, so it can't be used with the production API");
    expect(make({ apiKey: KEY, environment: "playground" })).toThrow("KLARNA_API_KEY is a live key, so it can't be used with the playground API");
    expect(make({ apiKey: TEST_KEY, environment: "playground" })).not.toThrow();
    for (const username of ["abc", "has space", "a".repeat(101), "abc/def"]) expect(make({ username, password: PASS }), username).toThrow("KLARNA_API_KEY, or KLARNA_USERNAME and KLARNA_PASSWORD, is missing");
    expect(make({ username: "a".repeat(100), password: PASS })).not.toThrow();
    expect(make({ username: "abcd", password: PASS })).not.toThrow();
    for (const password of [undefined, "short12", "has a space", "x".repeat(201), "tab\there0"]) expect(make({ username: USER, password }), String(password)).toThrow("KLARNA_PASSWORD is missing or not in the expected shape");
    expect(make({ username: USER, password: "!~".repeat(4) })).not.toThrow();
    expect(make({ username: USER, password: "x".repeat(200) })).not.toThrow();
    expect(make({ apiKey: KEY, region: "us" as never })).toThrow(new KlarnaConfigError("KLARNA_REGION must be eu, na or oc"));
    expect(make({ apiKey: KEY, region: "toString" as never })).toThrow("KLARNA_REGION must be eu, na or oc");
    expect(make({ apiKey: KEY, environment: "staging" as never })).toThrow(new KlarnaConfigError("KLARNA_ENVIRONMENT must be production or playground"));
    expect(make({ apiKey: KEY, environment: "toString" as never })).toThrow("KLARNA_ENVIRONMENT must be production or playground");
    expect(sent).toHaveLength(0);
  });

  it("sends a key as the Basic credential, and a username and password encoded", () => {
    expect(klarnaAuthorization({ apiKey: ` ${KEY} ` }, "production")).toBe(`Basic ${KEY}`);
    expect(klarnaAuthorization({ username: ` ${USER} `, password: ` ${PASS} ` }, "playground")).toBe(`Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`);
    // A key can go with its username as the password, as the portal shows it.
    expect(klarnaAuthorization({ username: USER, password: KEY }, "production")).toBe(`Basic ${Buffer.from(`${USER}:${KEY}`).toString("base64")}`);
  });

  it("goes to the host for its region and environment, North America by default", async () => {
    expect(KLARNA_API_URLS).toEqual({
      production: { eu: "https://api.klarna.com", na: "https://api-na.klarna.com", oc: "https://api-oc.klarna.com" },
      playground: { eu: "https://api.playground.klarna.com", na: "https://api-na.playground.klarna.com", oc: "https://api-oc.playground.klarna.com" },
    });
    const { fetch, sent } = scripted(PAYOUTS());
    expect(client(fetch).c.baseUrl).toBe(API);
    expect(client(fetch, { region: "eu" }).c.baseUrl).toBe("https://api.klarna.com");
    const oc = client(fetch, { apiKey: TEST_KEY, region: "oc", environment: "playground" }).c;
    expect(oc.baseUrl).toBe("https://api-oc.playground.klarna.com");
    await oc.payouts(RANGE);
    expect(sent[0]!.url.startsWith("https://api-oc.playground.klarna.com/settlements/v1/payouts?")).toBe(true);
    expect(sent[0]!.headers).toEqual({ authorization: `Basic ${TEST_KEY}`, accept: "application/json" });
  });

  it("lists payouts by date with GET only, then a payout's lines", async () => {
    const { fetch, sent } = scripted(PAYOUTS([{ a: 1 }], 1), json(200, { transactions: [{ b: 2 }], pagination: { count: 1, total: 1 } }));
    const { c } = client(fetch);
    expect(await c.payouts({ start: S, end: E, offset: 7 })).toEqual({ items: [{ a: 1 }], more: false });
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.url).toBe(`${API}${KLARNA_PAYOUTS_PATH}?start_date=${encodeURIComponent(S)}&end_date=${encodeURIComponent(E)}&size=${KLARNA_PAYOUT_PAGE_SIZE}&offset=7`);
    expect(sent[0]!.headers).toEqual({ authorization: `Basic ${KEY}`, accept: "application/json" });
    expect(await c.transactions("XISA_0-1", 0)).toEqual({ items: [{ b: 2 }], more: false });
    expect(sent[1]!.method).toBe("GET");
    expect(sent[1]!.url).toBe(`${API}${KLARNA_TRANSACTIONS_PATH}?payment_reference=XISA_0-1&size=${KLARNA_TRANSACTION_PAGE_SIZE}&offset=0`);
    expect([KLARNA_PAYOUTS_PATH, KLARNA_TRANSACTIONS_PATH, KLARNA_PAYOUT_PAGE_SIZE, KLARNA_TRANSACTION_PAGE_SIZE]).toEqual(["/settlements/v1/payouts", "/settlements/v1/transactions", 100, 500]);
  });

  it("works out whether more pages follow from the total, or a full page without one", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    const more = async (body: unknown, offset = 0) => (await client(scripted(json(200, body)).fetch).c.payouts({ ...RANGE, offset })).more;
    expect(await more({ payouts: rows(3), pagination: { count: 3, total: 4 } })).toBe(true);
    expect(await more({ payouts: rows(3), pagination: { count: 3, total: 3 } })).toBe(false);
    expect(await more({ payouts: rows(3), pagination: { count: 3, total: 13 } }, 10)).toBe(false);
    expect(await more({ payouts: rows(3), pagination: { count: 3, total: 14 } }, 10)).toBe(true);
    // No total, or one that isn't a whole number: a full page means more may follow.
    expect(await more({ payouts: rows(100), pagination: { count: 100 } })).toBe(true);
    expect(await more({ payouts: rows(99), pagination: { count: 99 } })).toBe(false);
    expect(await more({ payouts: rows(100), pagination: { count: 100, total: "100" } })).toBe(true);
    expect(await more({ payouts: rows(100), pagination: { count: 100, total: -1 } })).toBe(true);
    expect(await more({ payouts: rows(100), pagination: { count: 100, total: 1.5 } })).toBe(true);
    expect(await more({ payouts: rows(100), pagination: null })).toBe(true);
    expect(await more({ payouts: rows(100) })).toBe(true);
    // An empty page ends the list, whatever the total says.
    expect(await more({ payouts: [], pagination: { count: 0, total: 50 } })).toBe(false);
    const lines = async (n: number) => (await client(scripted(json(200, { transactions: rows(n), pagination: { count: n } })).fetch).c.transactions("R1", 0)).more;
    expect(await lines(500)).toBe(true);
    expect(await lines(499)).toBe(false);
  });

  it("checks what it is asked for before sending", async () => {
    const { fetch, sent } = scripted(PAYOUTS(), json(200, { transactions: [], pagination: { count: 0 } }));
    const { c } = client(fetch);
    for (const q of [
      { start: "2021-11-11", end: E },
      { start: S, end: "2026-11-11T15:00:00Z" },
      { start: `x${S}`, end: E },
      { start: S, end: `x${E}` },
      { start: S, end: `${E}x` },
      { start: E, end: S },
    ]) await expect(c.payouts({ ...q, offset: 0 }), JSON.stringify(q)).rejects.toThrow(new KlarnaApiError("a payout list must run from one ISO UTC time to a later one", 0));
    for (const offset of [-1, 1.5, Number.NaN]) await expect(c.payouts({ ...RANGE, offset }), String(offset)).rejects.toThrow("an offset must be a whole number, 0 or more");
    for (const ref of ["", "a b", "a/b", "../payouts", "a".repeat(101), "a?b=c"]) await expect(c.transactions(ref, 0), ref).rejects.toThrow("a payment reference must be letters, digits, - and _");
    await expect(c.transactions("R1", -1)).rejects.toThrow("an offset must be a whole number, 0 or more");
    await expect(c.transactions("R1", 0.5)).rejects.toThrow("an offset must be a whole number, 0 or more");
    expect(sent).toHaveLength(0);
    await c.payouts({ start: S, end: S, offset: 0 });
    await c.transactions("a".repeat(100), 3);
    expect(sent).toHaveLength(2);
  });

  it("says when Klarna turns down the credential, never repeating Klarna's words", async () => {
    for (const status of [401, 403]) {
      const { c } = client(scripted(json(status, { error_messages: ["secret detail"] })).fetch);
      const err = await c.payouts(RANGE).catch((e: Error) => e);
      expect(err).toBeInstanceOf(KlarnaConfigError);
      expect((err as Error).message).toBe(`Klarna turned down the credential for payouts (HTTP ${status})`);
      await expect(c.transactions("R1", 0)).rejects.toThrow(`Klarna turned down the credential for transactions (HTTP ${status})`);
    }
    const { c } = client(scripted(json(400, { error_messages: ["secret detail"] })).fetch);
    const err = (await c.payouts(RANGE).catch((e: Error) => e)) as KlarnaApiError;
    expect(err).toBeInstanceOf(KlarnaApiError);
    expect(err.message).toBe("Klarna answered HTTP 400 for payouts");
    expect(err.status).toBe(400);
    expect(err.name).toBe("KlarnaApiError");
    expect(new KlarnaConfigError("x").name).toBe("KlarnaConfigError");
    await expect(client(scripted(json(201, {})).fetch).c.payouts(RANGE)).rejects.toThrow("Klarna answered HTTP 201 for payouts");
  });

  it("says when an answer doesn't hold the list asked for", async () => {
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), json(200, { payouts: "x" }), json(200, { payouts: {} }), json(200, { transactions: [] })]) {
      const err = (await client(scripted(answer).fetch).c.payouts(RANGE).catch((e: Error) => e)) as KlarnaApiError;
      expect(err.message).toBe("Klarna answered without its payouts");
      expect(err.status).toBe(200);
    }
    await expect(client(scripted(json(200, { payouts: [] })).fetch).c.transactions("R1", 0)).rejects.toThrow("Klarna answered without its transactions");
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}, { "retry-after": "2" }), PAYOUTS([{}], 1));
      const { c, slept } = client(fetch);
      expect((await c.payouts(RANGE)).items).toHaveLength(1);
      expect(sent).toHaveLength(2);
      expect(slept, String(status)).toEqual([2000]);
    }
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "600" }), json(429, {}), json(429, {}, { "retry-after": "0" }), json(429, {}, { "retry-after": "soon" }));
    const { c, slept } = client(fetch);
    await expect(c.payouts(RANGE)).rejects.toThrow("Klarna answered HTTP 429 for payouts");
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([60_000, 2000, 4000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    for (const status of [400, 404, 501]) {
      const { fetch, sent } = scripted(json(status, {}), PAYOUTS());
      await expect(client(fetch).c.payouts(RANGE)).rejects.toThrow(`HTTP ${status}`);
      expect(sent).toHaveLength(1);
    }
    const { fetch, sent } = scripted(json(503, {}));
    await expect(client(fetch, { retries: 1 }).c.transactions("R1", 0)).rejects.toThrow("Klarna answered HTTP 503 for transactions");
    expect(sent).toHaveLength(2);
    const once = scripted(json(503, {}));
    await expect(client(once.fetch, { retries: 0 }).c.payouts(RANGE)).rejects.toThrow("HTTP 503");
    expect(once.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "0.01" }), PAYOUTS());
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await klarnaClient({ apiKey: KEY }).payouts(RANGE);
      expect(Date.now() - started).toBeGreaterThanOrEqual(5);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });
});

describe("Klarna reading helpers", () => {
  it("reads Klarna's times and days as UTC", () => {
    expect(klarnaTime("2026-03-01T07:52:26Z")).toBe("2026-03-01T07:52:26.000Z");
    expect(klarnaTime("2026-03-01T07:52:26.123456+02:00")).toBe("2026-03-01T05:52:26.123Z");
    expect(klarnaTime("2026-03-01T07:52:26-05:00")).toBe("2026-03-01T12:52:26.000Z");
    expect(klarnaTime("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    expect(klarnaTime("2028-02-29T23:59:59")).toBe("2028-02-29T23:59:59.000Z");
    expect(klarnaTime("2026-03-01T00:00:00.5Z")).toBe("2026-03-01T00:00:00.500Z");
    for (const bad of [undefined, null, 20260301, "", "2026-02-30", "2026-02-29T00:00:00Z", "2026-13-01", "2026-03-01T24:00:00Z", "2026-03-01T23:60:00Z", "2026-03-01T07:52Z", "2026-03-01T07:52:26.1234567Z", "x2026-03-01", "2026-03-01x", "2026-03-01 07:52:26", "2026-03-01T07:52:26+0200"]) expect(klarnaTime(bad), String(bad)).toBeUndefined();
  });

  it("reads a time with no zone as UTC wherever the server is", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      expect(klarnaTime("2026-03-01T07:52:26")).toBe("2026-03-01T07:52:26.000Z");
      expect(klarnaTime("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("makes references, and reads a payout's payment reference", () => {
    expect(klarnaPayoutRef("XISA1")).toBe("klarna:payout:XISA1");
    expect(klarnaOrderRef("o-1")).toBe("klarna:order:o-1");
    expect(klarnaPaymentReference({ payment_reference: "XISA_1-a" })).toBe("XISA_1-a");
    for (const bad of [null, [], "XISA1", {}, { payment_reference: 12 }, { payment_reference: "" }, { payment_reference: "a b" }, { payment_reference: "a".repeat(101) }]) expect(klarnaPaymentReference(bad), JSON.stringify(bad)).toBeUndefined();
    expect(klarnaPaymentReference({ payment_reference: "a".repeat(100) })).toBe("a".repeat(100));
  });
});

describe("Klarna payout events", () => {
  const payout = () => {
    klarnaPayout.reset();
    return klarnaPayout.one({ payout_date: "2026-03-01T06:00:00Z" });
  };

  it("keeps what Klarna settled, under the payment reference, with every total", () => {
    const e = klarnaPayoutEvent(payout(), { receivedAt: RECEIVED });
    expect(e.type).toBe(KLARNA_PAYOUT_EVENT);
    expect(KLARNA_PAYOUT_EVENT).toBe("payout.updated");
    expect(e.occurredAt).toBe("2026-03-01T06:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toEqual({
      system: "Klarna",
      payoutId: "klarna:payout:XISA0000000001",
      amountCents: 85_200,
      currency: "USD",
      status: "paid",
      method: "bank_transfer",
      type: "settlement",
      arrivalDate: "2026-03-01",
      settledOn: "2026-03-01",
      settlementType: "net",
      salesCents: 120_000,
      refundCents: 30_000,
      feeCents: 3_600,
      feeRefundCents: 0,
      commissionCents: 1_200,
      reversalCents: 0,
      holdbackCents: 0,
      releaseCents: 0,
      chargeCents: 0,
      creditCents: 0,
      repayCents: 0,
      taxCents: 0,
      taxRefundCents: 0,
      depositCents: 0,
      openingDebtCents: 0,
      closingDebtCents: 0,
    });
    expect(e.idempotencyKey).toMatch(/^klarna:payout:XISA0000000001:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(JSON.stringify(e)).not.toContain("N100000");
  });

  it("reads each total by its own name, and one that doesn't read as null", () => {
    const p = payout();
    const names = ["sale_amount", "return_amount", "fee_amount", "fee_refund_amount", "commission_amount", "reversal_amount", "holdback_amount", "release_amount", "charge_amount", "credit_amount", "repay_amount", "tax_amount", "tax_refund_amount", "deposit_amount", "opening_debt_balance_amount", "closing_debt_balance_amount"];
    p.totals = Object.fromEntries(names.map((n, i) => [n, -(i + 1)]));
    (p.totals as Record<string, unknown>).settlement_amount = -5;
    const e = klarnaPayoutEvent(p, { receivedAt: RECEIVED });
    expect(e.payload).toMatchObject({
      amountCents: -5,
      salesCents: -1,
      refundCents: -2,
      feeCents: -3,
      feeRefundCents: -4,
      commissionCents: -5,
      reversalCents: -6,
      holdbackCents: -7,
      releaseCents: -8,
      chargeCents: -9,
      creditCents: -10,
      repayCents: -11,
      taxCents: -12,
      taxRefundCents: -13,
      depositCents: -14,
      openingDebtCents: -15,
      closingDebtCents: -16,
    });
    p.totals = { settlement_amount: 0 };
    expect(klarnaPayoutEvent(p, { receivedAt: RECEIVED }).payload.amountCents).toBe(0);
    p.totals = { settlement_amount: 10, sale_amount: 1.5, fee_amount: "3", tax_amount: Number.MAX_SAFE_INTEGER + 2 };
    const sparse = klarnaPayoutEvent(p, { receivedAt: RECEIVED }).payload;
    expect(sparse.amountCents).toBe(10);
    for (const name of ["salesCents", "feeCents", "taxCents", "refundCents", "closingDebtCents"]) expect(sparse[name], name).toBeNull();
  });

  it("reads Klarna's settlement types, and an unknown one as null", () => {
    const p = payout();
    for (const [type, kept] of [["GROSS", "gross"], ["NET", "net"], ["GROSS_FEE", "gross_fee"], ["OTHER", null], ["net", null], [3, null]] as const) {
      p.merchant_settlement_type = type;
      expect(klarnaPayoutEvent(p, { receivedAt: RECEIVED }).payload.settlementType, String(type)).toBe(kept);
    }
  });

  it("reads a payout day with no time, and a time in another zone", () => {
    const p = payout();
    p.payout_date = "2026-03-01";
    expect(klarnaPayoutEvent(p, { receivedAt: RECEIVED })).toMatchObject({ occurredAt: "2026-03-01T00:00:00.000Z", payload: { arrivalDate: "2026-03-01", settledOn: "2026-03-01" } });
    p.payout_date = "2026-03-01T23:30:00-02:00";
    expect(klarnaPayoutEvent(p, { receivedAt: RECEIVED }).payload.settledOn).toBe("2026-03-02");
  });

  it("keys each version by what was kept, so an unchanged one is a duplicate", () => {
    const a = klarnaPayoutEvent(payout(), { receivedAt: RECEIVED });
    const b = klarnaPayoutEvent(payout(), { receivedAt: "2026-12-01T00:00:00.000Z" });
    expect(b.idempotencyKey).toBe(a.idempotencyKey);
    const p = payout();
    (p.totals as Record<string, unknown>).fee_amount = 3_700;
    expect(klarnaPayoutEvent(p, { receivedAt: RECEIVED }).idempotencyKey).not.toBe(a.idempotencyKey);
    const q = payout();
    q.merchant_id = "N200000";
    q.klarna_comment = "changed";
    expect(klarnaPayoutEvent(q, { receivedAt: RECEIVED }).idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a payout that doesn't read, listing why", () => {
    const e = klarnaPayoutEvent({ payment_reference: "a b", payout_date: "soon", currency_code: "usd", totals: { settlement_amount: "12" } }, { receivedAt: RECEIVED });
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe(KLARNA_PAYOUT_EVENT);
    expect(e.payload).toEqual({
      system: "Klarna",
      payoutId: null,
      problems: ["payout has no payment reference that reads", "payout has no payout date that reads", "payout has no settlement amount that reads", "payout has no currency that reads"],
    });
    expect(e.idempotencyKey).toMatch(/^klarna:unreadable_payout:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    const p = payout();
    p.totals = null;
    expect(klarnaPayoutEvent(p, { receivedAt: RECEIVED }).payload).toEqual({ system: "Klarna", payoutId: "klarna:payout:XISA0000000001", problems: ["payout has no settlement amount that reads"] });
    for (const currency_code of [undefined, "US", "USDX", 840]) expect(klarnaPayoutEvent({ ...payout(), currency_code }, { receivedAt: RECEIVED }).payload.problems, String(currency_code)).toEqual(["payout has no currency that reads"]);
    for (const raw of [null, "x", []]) expect(klarnaPayoutEvent(raw, { receivedAt: RECEIVED }).payload.problems, JSON.stringify(raw)).toHaveLength(4);
  });
});

describe("Klarna transaction events", () => {
  const line = (overrides: Record<string, unknown> = {}) => {
    klarnaTransaction.reset();
    return klarnaTransaction.one(overrides);
  };
  const ctx = { receivedAt: RECEIVED, paymentReference: "XISA1", line: 0 };

  it("keeps what finance matches on, and not Klarna's comment, the shipping country or the second reference", () => {
    const e = klarnaTransactionEvent(line(), ctx);
    expect(e.type).toBe(KLARNA_TRANSACTION_EVENT);
    expect(KLARNA_TRANSACTION_EVENT).toBe("balance.transaction_recorded");
    expect(e.occurredAt).toBe("2026-01-01T01:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toEqual({
      system: "Klarna",
      payoutId: "klarna:payout:XISA1",
      type: "sale",
      detailedType: "purchase",
      amountCents: 40_000,
      currency: "USD",
      orderId: "klarna:order:00000001-0000-4000-8000-000000000001",
      shortOrderId: "000001A",
      captureId: "00000002-0000-4000-8000-000000000001",
      refundId: null,
      merchantReference: "TEST-1",
      vatAmountCents: 0,
      vatRateBasisPoints: 0,
      purchaseCountry: "US",
      paymentMethod: "installment",
      saleAt: "2026-01-01T01:00:00.000Z",
      capturedAt: "2026-01-01T01:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(/^klarna:transaction:XISA1:0:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    const all = JSON.stringify(e);
    for (const hidden of ["Test comment", "Engagement ring", "shipping", "installments"]) expect(all, hidden).not.toContain(hidden);
  });

  it("reads every type Klarna lists, and turns down any other", () => {
    for (const type of ["COMMISSION", "SALE", "REVERSAL", "RETURN", "TAX", "FEE", "FEE_REFUND", "CORRECTION", "REVERSAL_MERCHANT_PROTECTION", "CHARGE", "CREDIT", "HOLDBACK", "RELEASE"]) expect(klarnaTransactionEvent(line({ type }), ctx).payload.type, type).toBe(type.toLowerCase());
    for (const type of ["PURCHASE", "sale", "", 1, undefined]) expect(klarnaTransactionEvent(line({ type }), ctx).payload.problems, String(type)).toEqual(["transaction has no type that reads"]);
  });

  it("reads a return with its refund, and a line dated by its sale when it has no capture", () => {
    const e = klarnaTransactionEvent(line({ type: "RETURN", amount: -15_000, refund_id: "r-1", capture_id: null, capture_date: null, detailed_type: "PURCHASE_RETURN", sale_date: "2026-02-01" }), ctx);
    expect(e.occurredAt).toBe("2026-02-01T00:00:00.000Z");
    expect(e.payload).toMatchObject({ type: "return", amountCents: -15_000, refundId: "r-1", captureId: null, detailedType: "purchase_return", saleAt: "2026-02-01T00:00:00.000Z", capturedAt: null });
    // The capture date comes first when both read.
    const both = klarnaTransactionEvent(line({ sale_date: "2026-02-01", capture_date: "2026-02-03" }), ctx);
    expect(both.occurredAt).toBe("2026-02-03T00:00:00.000Z");
    const capturedOnly = klarnaTransactionEvent(line({ sale_date: "later", capture_date: "2026-02-03" }), ctx);
    expect(capturedOnly.occurredAt).toBe("2026-02-03T00:00:00.000Z");
    expect(capturedOnly.payload.saleAt).toBeNull();
  });

  it("keeps the optional fields only when they read", () => {
    const e = klarnaTransactionEvent(
      line({ order_id: "a b", short_order_id: "", capture_id: 7, refund_id: "x/y", merchant_reference1: "   ", vat_amount: 1.5, vat_rate: "2000", purchase_country: "USA", initial_payment_method_type: "pay later", detailed_type: "x".repeat(61) }),
      ctx,
    );
    expect(e.payload).toMatchObject({ orderId: null, shortOrderId: null, captureId: null, refundId: null, merchantReference: null, vatAmountCents: null, vatRateBasisPoints: null, purchaseCountry: null, paymentMethod: null, detailedType: null });
    const kept = klarnaTransactionEvent(line({ merchant_reference1: ` ${"R".repeat(120)} `, vat_amount: 1000, vat_rate: 2000, purchase_country: "GB", initial_payment_method_type: "PAY_LATER_BY_CARD", detailed_type: `D${"X".repeat(59)}` }), ctx).payload;
    expect(kept).toMatchObject({ merchantReference: "R".repeat(100), vatAmountCents: 1000, vatRateBasisPoints: 2000, purchaseCountry: "GB", paymentMethod: "pay_later_by_card", detailedType: `d${"x".repeat(59)}` });
    for (const detailed_type of ["dX", `D${"X".repeat(60)}`, "PAY LATER", "FEE!", "Fee"]) expect(klarnaTransactionEvent(line({ detailed_type }), ctx).payload.detailedType, detailed_type).toBeNull();
    for (const purchase_country of ["us", "U", 1]) expect(klarnaTransactionEvent(line({ purchase_country }), ctx).payload.purchaseCountry, String(purchase_country)).toBeNull();
  });

  it("tells two lines alike apart by their place in the payout, and keys each by what was kept", () => {
    const fee = { type: "FEE", amount: -100, order_id: "o-1" };
    const a = klarnaTransactionEvent(line(fee), ctx);
    const b = klarnaTransactionEvent(line(fee), { ...ctx, line: 1 });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(b.idempotencyKey).toMatch(/^klarna:transaction:XISA1:1:/);
    expect(klarnaTransactionEvent(line(fee), { ...ctx, receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(klarnaTransactionEvent(line({ ...fee, amount: -101 }), ctx).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(klarnaTransactionEvent(line({ ...fee, klarna_comment: "other" }), ctx).idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a line that doesn't read, listing why", () => {
    const e = klarnaTransactionEvent({ amount: 1.5, currency_code: "usd", sale_date: "x" }, ctx);
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe(KLARNA_TRANSACTION_EVENT);
    expect(e.payload).toEqual({ system: "Klarna", payoutId: "klarna:payout:XISA1", problems: ["transaction has no type that reads", "transaction has no amount that reads", "transaction has no currency that reads", "transaction has no date that reads"] });
    expect(e.idempotencyKey).toMatch(/^klarna:unreadable_transaction:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    for (const raw of [null, "x", []]) expect(klarnaTransactionEvent(raw, ctx).payload.problems, JSON.stringify(raw)).toHaveLength(4);
    expect(klarnaTransactionEvent(line({ amount: "400" }), ctx).payload.problems).toEqual(["transaction has no amount that reads"]);
    expect(klarnaTransactionEvent(line({ amount: 0 }), ctx).payload.amountCents).toBe(0);
    expect(klarnaTransactionEvent(line({ currency_code: "US" }), ctx).payload.problems).toEqual(["transaction has no currency that reads"]);
    // An order that doesn't read isn't a problem: the line is kept without it.
    expect(klarnaTransactionEvent(line({ order_id: undefined }), ctx).payload.orderId).toBeNull();
  });
});

describe("Klarna checkpoint", () => {
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseKlarnaCursor(null)).toBeNull();
    const pass = { start: S, end: E, offset: 3 };
    expect(parseKlarnaCursor(JSON.stringify({ pass, done: false, nextFrom: E }))).toEqual({ pass, done: false, nextFrom: E });
    expect(parseKlarnaCursor(JSON.stringify({ pass: null, done: true, nextFrom: E }))).toEqual({ pass: null, done: true, nextFrom: E });
    expect(parseKlarnaCursor(JSON.stringify({ pass: { ...pass, offset: 0, end: S }, done: true, nextFrom: E, extra: 1 }))).toEqual({ pass: { start: S, end: S, offset: 0 }, done: true, nextFrom: E });
    for (const bad of [
      "not json",
      "null",
      "[]",
      "3",
      JSON.stringify({ pass: null, done: "yes", nextFrom: E }),
      JSON.stringify({ pass: null, nextFrom: E }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-11T15:00:00Z" }),
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ done: true, nextFrom: E }),
      JSON.stringify({ pass: "x", done: true, nextFrom: E }),
      JSON.stringify({ pass: [], done: true, nextFrom: E }),
      JSON.stringify({ pass: { ...pass, start: "2021-11-11" }, done: true, nextFrom: E }),
      JSON.stringify({ pass: { ...pass, end: "later" }, done: true, nextFrom: E }),
      JSON.stringify({ pass: { ...pass, start: E, end: S }, done: true, nextFrom: E }),
      JSON.stringify({ pass: { ...pass, offset: -1 }, done: true, nextFrom: E }),
      JSON.stringify({ pass: { ...pass, offset: 1.5 }, done: true, nextFrom: E }),
      JSON.stringify({ pass: { ...pass, offset: "3" }, done: true, nextFrom: E }),
      JSON.stringify({ pass: { start: S, end: E }, done: true, nextFrom: E }),
    ])
      expect(() => parseKlarnaCursor(bad), bad).toThrow("Klarna checkpoint is not in the expected shape");
  });
});

describe("Klarna connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(klarnaDocMock(account())), expected: { ingested: 12 } });
    expect(result.full.ingested).toBe(12);
  });

  it("imports five years of payouts, each with its lines, then stops for good", async () => {
    const mock = klarnaDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(12);
    expect(mock.reads[0]).toEqual({ path: KLARNA_PAYOUTS_PATH, query: { start_date: S, end_date: E, size: "100", offset: "0" } });
    // Oldest first, each payout's lines read before the next payout.
    expect(mock.reads.slice(1).map((r) => r.query.payment_reference)).toEqual(["XISA0000000004", "XISA0000000003", "XISA0000000002", "XISA0000000001"]);
    expect(mock.reads).toHaveLength(5);
    expect(parseKlarnaCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(5);
  });

  it("makes each payout with its lines one batch, keeping how far the pass has read, and resumes there", async () => {
    klarnaPayout.reset();
    klarnaTransaction.reset();
    const payouts = klarnaPayout.many(KLARNA_PAYOUT_PAGE_SIZE + 2, (n) => ({ payout_date: ago(300 - n) }));
    const data: KlarnaMockData = { apiKey: KEY, payouts, transactions: { [String(payouts[0]!.payment_reference)]: klarnaTransaction.many(KLARNA_TRANSACTION_PAGE_SIZE + 1) } };
    const mock = klarnaDocMock(data);
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches).toHaveLength(102);
    expect(batches[0]!.events).toHaveLength(502);
    expect(batches.slice(1).every((b) => b.events.length === 1)).toBe(true);
    // The lines of the first payout take two pages.
    expect(mock.reads.filter((r) => r.path === KLARNA_TRANSACTIONS_PATH && r.query.payment_reference === payouts[0]!.payment_reference).map((r) => r.query.offset)).toEqual(["0", "500"]);
    expect(mock.reads.filter((r) => r.path === KLARNA_PAYOUTS_PATH).map((r) => r.query.offset)).toEqual(["0", "100"]);
    const cursors = batches.map((b) => parseKlarnaCursor(b.cursor ?? null)!);
    expect(cursors[0]).toEqual({ pass: { start: S, end: E, offset: 1 }, done: false, nextFrom: "2026-11-08T15:00:00.000Z" });
    expect(cursors[99]!.pass!.offset).toBe(100);
    expect(cursors[100]).toEqual({ pass: { start: S, end: E, offset: 101 }, done: false, nextFrom: "2026-11-08T15:00:00.000Z" });
    expect(cursors[101]).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
    // Each line keeps its place in the payout across pages.
    expect(new Set(eventsOf([batches[0]!]).map((e) => e.idempotencyKey)).size).toBe(502);
    expect((batches[0]!.events[501] as KlarnaEvent).idempotencyKey).toMatch(/:500:/);
    // Resumed a day later, the pass reads on from where it stood and keeps where the next later sync starts.
    const resumed = klarnaDocMock(data);
    const rest = await drain(connector(resumed, { now: () => new Date(NOW().getTime() + DAY_MS) }).historicalImport({ cursor: batches[99]!.cursor ?? null } as never));
    expect(rest).toHaveLength(2);
    expect(resumed.reads.filter((r) => r.path === KLARNA_PAYOUTS_PATH).map((r) => r.query)).toEqual([{ start_date: S, end_date: E, size: "100", offset: "100" }]);
    expect(parseKlarnaCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
    expect(eventsOf(rest).map((e) => e.receivedAt)).toEqual(["2026-11-12T15:00:00.000Z", "2026-11-12T15:00:00.000Z"]);
    // A resumed later sync goes on from its pass too, keeping what it knew of the import.
    const mid = JSON.stringify({ pass: { start: S, end: E, offset: 101 }, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const later = await drain(connector(klarnaDocMock(data)).incrementalSync({ cursor: mid } as never));
    expect(later).toHaveLength(1);
    expect(parseKlarnaCursor(later[0]!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const midDone = JSON.stringify({ pass: { start: S, end: E, offset: 100 }, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const doneLater = await drain(connector(klarnaDocMock(data)).incrementalSync({ cursor: midDone } as never));
    expect(doneLater.map((b) => parseKlarnaCursor(b.cursor ?? null)!.done)).toEqual([true, true]);
    // An import that finished doesn't run again, even from a checkpoint left mid-pass.
    expect(await drain(connector(klarnaDocMock(data)).historicalImport({ cursor: midDone } as never))).toEqual([]);
    const midImport = JSON.stringify({ pass: { start: S, end: E, offset: 100 }, done: false, nextFrom: "2026-11-01T00:00:00.000Z" });
    const ended = await drain(connector(klarnaDocMock(data)).incrementalSync({ cursor: midImport } as never));
    expect(ended.map((b) => parseKlarnaCursor(b.cursor ?? null))).toEqual([
      { pass: { start: S, end: E, offset: 101 }, done: false, nextFrom: "2026-11-01T00:00:00.000Z" },
      { pass: null, done: false, nextFrom: "2026-11-01T00:00:00.000Z" },
    ]);
  });

  it("ends a pass on an empty page, with or without a total", async () => {
    // A page past the end, as a resumed pass can find.
    const data = account();
    const past = await drain(connector(klarnaDocMock(data)).historicalImport({ cursor: JSON.stringify({ pass: { start: S, end: E, offset: 50 }, done: false, nextFrom: E }) } as never));
    expect(past.map((b) => [b.events.length, parseKlarnaCursor(b.cursor ?? null)])).toEqual([[0, { pass: null, done: true, nextFrom: E }]]);
    // Without a total, a full page reads on; the empty one after it ends the pass.
    klarnaPayout.reset();
    const payouts = klarnaPayout.many(KLARNA_PAYOUT_PAGE_SIZE, (n) => ({ payout_date: ago(200 - n) }));
    const mock = klarnaDocMock({ apiKey: KEY, payouts, transactions: {}, noTotal: true });
    const batches = await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(batches).toHaveLength(101);
    expect(batches[99]!.events).toHaveLength(1);
    expect(parseKlarnaCursor(batches[99]!.cursor ?? null)!.pass).toEqual({ start: S, end: E, offset: 100 });
    expect(batches[100]!.events).toHaveLength(0);
    expect(parseKlarnaCursor(batches[100]!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
  });

  it("lists payouts made since three days before the last pass on each later sync", async () => {
    const data = account();
    const mock = klarnaDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back three days.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.filter((r) => r.path === KLARNA_PAYOUTS_PATH).at(-1)!.query).toEqual({ start_date: "2026-11-08T15:00:00.000Z", end_date: E, size: "100", offset: "0" });
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(3);
    expect(parseKlarnaCursor(first.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-08T15:00:00.000Z" });
    expect(KLARNA_OVERLAP_MS).toBe(3 * DAY_MS);
    // Klarna publishes a payout dated yesterday after the last sync.
    klarnaPayout.reset();
    const late = klarnaPayout.one({ payment_reference: "XISALATE", payout_date: ago(-1) });
    data.payouts.push(late);
    data.transactions.XISALATE = [klarnaTransaction.one()];
    const later = () => new Date(NOW().getTime() + 2 * DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.filter((r) => r.path === KLARNA_PAYOUTS_PATH).at(-1)!.query).toEqual({ start_date: "2026-11-08T15:00:00.000Z", end_date: "2026-11-13T15:00:00.000Z", size: "100", offset: "0" });
    expect(sync.ingested).toBe(2);
    expect(parseKlarnaCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-10T15:00:00.000Z" });
    // A later sync after the import ended keeps saying so.
    const doneCursor = JSON.stringify({ pass: null, done: true, nextFrom: new Date(NOW().getTime() - 40 * DAY_MS).toISOString() });
    const again = await drain(connector(klarnaDocMock(data)).incrementalSync({ cursor: doneCursor } as never));
    // The payouts of 1 and 30 days ago, with their lines; the late one is dated after now.
    expect(eventsOf(again)).toHaveLength(6);
    expect(parseKlarnaCursor(again.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08T15:00:00.000Z" });
  });

  it("dead-letters a payout or line that doesn't read and keeps going, reading no lines for a payout without a reference", async () => {
    const data = account();
    data.payouts[4]!.payout_date = ago(2);
    data.payouts[4]!.payment_reference = "bad ref";
    data.transactions[String(data.payouts[0]!.payment_reference)]![0]!.amount = "lots";
    const mock = klarnaDocMock(data);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(11);
    expect(report.deadLettered).toBe(2);
    expect(mock.reads.filter((r) => r.path === KLARNA_TRANSACTIONS_PATH)).toHaveLength(4);
    // A payout with a reference but no date that reads is dead-lettered, and its lines are still read.
    const undated = account();
    const ref = String(undated.payouts[0]!.payment_reference);
    undated.payouts = [{ ...undated.payouts[0]!, payout_date: "soon" }];
    const fake: KlarnaClient = { baseUrl: API, payouts: async () => ({ items: undated.payouts, more: false }), transactions: async (r) => ({ items: r === ref ? undated.transactions[ref]! : [], more: false }) };
    const lines = eventsOf(await drain(klarnaConnector({ client: fake, now: NOW }).historicalImport({ cursor: null } as never)));
    expect(lines.map((e) => e.occurredAt === undefined)).toEqual([true, false, false]);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = klarnaDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(12);
    expect(slept).toEqual([1000, 1000]);
  });

  it("signs in with a username and password, and says when Klarna turns a credential down", async () => {
    const mock = klarnaDocMock(account({ apiKey: undefined, username: USER, password: PASS }));
    const batches = await drain(connector(mock, { apiKey: undefined, username: USER, password: PASS }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(12);
    const wrong = klarnaDocMock(account({ apiKey: `${KEY}1` }));
    await expect(drain(connector(wrong).historicalImport({ cursor: null } as never))).rejects.toThrow("Klarna turned down the credential for payouts (HTTP 401)");
    expect(wrong.reads).toHaveLength(0);
  });

  it("checks its options, reading a blank or mixed-case region and environment", async () => {
    const mock = klarnaDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { region: "us" })).toThrow("KLARNA_REGION must be eu, na or oc");
    expect(() => connector(mock, { environment: "staging" })).toThrow("KLARNA_ENVIRONMENT must be production or playground");
    expect(() => connector(mock, { region: " ", environment: " " })).not.toThrow();
    expect(() => connector(mock, { apiKey: "x" })).toThrow("KLARNA_API_KEY");
    expect(() => connector(mock, { apiKey: "x", client: {} as KlarnaClient })).not.toThrow();
    expect(connector(mock).source).toBe("klarna");
    const eu = klarnaDocMock(account({ apiKey: TEST_KEY, baseUrl: "https://api.playground.klarna.com" }));
    const batches = await drain(connector(eu, { apiKey: TEST_KEY, region: " EU ", environment: " Playground " }).historicalImport({ cursor: null } as never));
    expect(eventsOf(batches)).toHaveLength(12);
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = klarnaDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.start_date).toBe("2025-11-11T15:00:00.000Z");
    const queries: { start: string; end: string }[] = [];
    const fake: KlarnaClient = { baseUrl: API, payouts: async (q) => (queries.push(q), { items: [], more: false }), transactions: async () => ({ items: [], more: false }) };
    const before = Date.now();
    await drain(klarnaConnector({ client: fake }).incrementalSync({ cursor: null } as never));
    await drain(klarnaConnector({ client: fake }).historicalImport({ cursor: null } as never));
    const after = Date.now();
    const s = Date.parse(queries[0]!.start);
    expect(s).toBeGreaterThanOrEqual(before - KLARNA_OVERLAP_MS);
    expect(s).toBeLessThanOrEqual(after - KLARNA_OVERLAP_MS);
    for (const q of queries) {
      expect(Date.parse(q.end)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(q.end)).toBeLessThanOrEqual(after);
    }
  });

  it("only ever sends GET requests to the payouts and settlement transactions lists", async () => {
    const mock = klarnaDocMock(account());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`))).toEqual(new Set([`GET ${API}/settlements/v1/payouts`, `GET ${API}/settlements/v1/transactions`]));
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(KLARNA_WRITES).toEqual([
      { integration: "klarna", name: "capture_order", description: "Capture all or part of an authorized Klarna order, so the merchant is paid", kind: "update", approval: "each", dailyCap: 20 },
      { integration: "klarna", name: "refund_order", description: "Refund all or part of a captured Klarna order", kind: "update", approval: "each", dailyCap: 10 },
    ]);
    const c = connector(klarnaDocMock(account()));
    expect(c.writes).toBe(KLARNA_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "capture_order", integration: "klarna", outcome: "refused" },
      { action: "refund_order", integration: "klarna", outcome: "refused" },
    ]);
  });
});

describe("Klarna doc mock", () => {
  it("checks the credential, the paging and the date filters", async () => {
    const mock = klarnaDocMock(account());
    const list = (auth: string, path: string, query = "") => mock.fetch(`${API}${path}${query}`, { headers: { authorization: auth } });
    const BASIC = `Basic ${KEY}`;
    expect((await list("", KLARNA_PAYOUTS_PATH)).status).toBe(401);
    expect((await list(`Basic ${TEST_KEY}`, KLARNA_TRANSACTIONS_PATH)).status).toBe(401);
    for (const q of ["?size=0", "?size=501", "?size=x", "?offset=-1", "?offset=1.5", "?start_date=2026-01-01", "?end_date=soon"]) expect((await list(BASIC, KLARNA_PAYOUTS_PATH, q)).status, q).toBe(400);
    const first = (await (await list(BASIC, KLARNA_PAYOUTS_PATH, "?size=2")).json()) as { payouts: Record<string, unknown>[]; pagination: Record<string, unknown> };
    expect(first.payouts.map((p) => p.payment_reference)).toEqual(["XISA0000000005", "XISA0000000004"]);
    expect(first.pagination).toMatchObject({ count: 2, offset: 0, total: 5 });
    expect(first.pagination.next).toContain("offset=2");
    expect(first.pagination.prev).toBeUndefined();
    const second = (await (await list(BASIC, KLARNA_PAYOUTS_PATH, "?size=2&offset=2")).json()) as { pagination: Record<string, unknown> };
    expect(second.pagination.prev).toContain("offset=0");
    const all = (await (await list(BASIC, KLARNA_PAYOUTS_PATH)).json()) as { payouts: unknown[]; pagination: Record<string, unknown> };
    expect(all.payouts).toHaveLength(5);
    expect(all.pagination.next).toBeUndefined();
    const ranged = (await (await list(BASIC, KLARNA_PAYOUTS_PATH, `?start_date=${encodeURIComponent(ago(31))}&end_date=${encodeURIComponent(ago(1))}`)).json()) as { payouts: unknown[] };
    expect(ranged.payouts).toHaveLength(2);
    const usd = (await (await list(BASIC, KLARNA_PAYOUTS_PATH, "?currency_code=EUR")).json()) as { payouts: unknown[] };
    expect(usd.payouts).toHaveLength(0);
    const lines = (await (await list(BASIC, KLARNA_TRANSACTIONS_PATH, "?payment_reference=XISA0000000001")).json()) as { transactions: unknown[] };
    expect(lines.transactions).toHaveLength(2);
    const none = (await (await list(BASIC, KLARNA_TRANSACTIONS_PATH, "?payment_reference=NOPE")).json()) as { transactions: unknown[] };
    expect(none.transactions).toHaveLength(0);
    const every = (await (await list(BASIC, KLARNA_TRANSACTIONS_PATH)).json()) as { transactions: unknown[] };
    expect(every.transactions).toHaveLength(10);
    const login = klarnaDocMock(account({ apiKey: undefined, username: USER, password: PASS }));
    expect((await login.fetch(`${API}${KLARNA_PAYOUTS_PATH}`, { headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}` } })).status).toBe(200);
    const bare = klarnaDocMock(account({ noTotal: true }));
    const page = (await (await bare.fetch(`${API}${KLARNA_PAYOUTS_PATH}`, { headers: { authorization: BASIC } })).json()) as { pagination: Record<string, unknown> };
    expect(page.pagination.total).toBeUndefined();
  });
});
