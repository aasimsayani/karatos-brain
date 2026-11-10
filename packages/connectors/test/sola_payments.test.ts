import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, solaDocMock, solaEnteredDate, solaTransaction, synthetic, testPipeline, type SolaMock, type SolaMockData } from "@karatos/connector-testkit";
import {
  SOLA_API_VERSION,
  SOLA_CHARGE_EVENT,
  SOLA_DEFAULT_TIME_ZONE,
  SOLA_OVERLAP_DAYS,
  SOLA_REFUND_EVENT,
  SOLA_REPORT_COMMAND,
  SOLA_REPORT_PAGE,
  SOLA_REPORT_URL,
  SOLA_SPAN_DAYS,
  SOLA_WRITES,
  SolaApiError,
  SolaConfigError,
  formCustomerRefs,
  parseSolaCursor,
  solaCents,
  solaClient,
  solaConnector,
  solaRow,
  solaTime,
  solaTransactionEvent,
  solaWallClock,
  type SolaClient,
  type SolaCursor,
  type SolaEvent,
  type SolaOptions,
} from "../src/index.js";

// A credential-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["sola", "test", "0".repeat(24)].join("_");
const CUSTOMER_KEY = "c".repeat(40);
const NY = "America/New_York";
const NOW = () => new Date("2026-11-10T15:00:00.000Z");
const RECEIVED = "2026-11-10T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const ctx = { customerKey: CUSTOMER_KEY, timeZone: NY, receivedAt: RECEIVED };

/** Sola's time for `ago` days before NOW, on New York's clock. */
const enteredAgo = (ago: number) => solaEnteredDate(solaWallClock(NOW().getTime() - ago * DAY_MS, NY));

/** Sales entered 1, 30, 1,000 and 1,820 days ago, and six years ago. */
function account(overrides: Partial<SolaMockData> = {}): SolaMockData {
  solaTransaction.reset();
  return { apiKey: KEY, rows: [1, 30, 1000, 1820, 2200].map((ago) => solaTransaction.one({ xEnteredDate: enteredAgo(ago) })), ...overrides };
}

const connector = (mock: SolaMock, overrides: Partial<SolaOptions> = {}) => solaConnector({ apiKey: KEY, customerKey: CUSTOMER_KEY, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as SolaEvent[];

async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers in turn and records what was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const OK = { xResult: "S", xReportData: [] };
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof solaClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = solaClient({ apiKey: KEY, fetch, sleep: async (ms) => void slept.push(ms), ...extra });
  return { c, slept };
};
const B = "2026-11-01 00:00:00";
const E = "2026-11-30 23:59:59";

describe("Sola client", () => {
  it("checks its key before sending anything", () => {
    const { fetch, sent } = scripted(json(200, OK));
    const make = (apiKey: unknown) => () => solaClient({ apiKey: apiKey as string, fetch });
    for (const apiKey of ["", "a".repeat(15), "a".repeat(251), `${KEY}!`, `${KEY} x`, undefined]) expect(make(apiKey), String(apiKey)).toThrow("SOLA_API_KEY is missing or not in the expected shape");
    expect(make("")).toThrow(SolaConfigError);
    for (const ok of ["a".repeat(16), "a".repeat(250), ` ${KEY} `, "A-b_9".repeat(4)]) expect(make(ok)).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("posts Report:All to the reporting address only, oldest first", async () => {
    const { fetch, sent } = scripted(json(200, { xResult: "S", xReportData: [{ xRefNum: "1" }] }));
    const { c } = client(fetch, { apiKey: ` ${KEY} ` });
    expect(await c.transactions(B, E)).toEqual([{ xRefNum: "1" }]);
    expect(sent).toEqual([
      {
        url: "https://x1.cardknox.com/reportjson",
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ xKey: KEY, xVersion: "5.0.0", xSoftwareName: "KaratOS", xSoftwareVersion: "1.0", xCommand: "Report:All", xBeginDate: B, xEndDate: E, xGetNewest: false, xMaxRecords: 1000 }),
      },
    ]);
    expect([SOLA_REPORT_URL, SOLA_REPORT_COMMAND, SOLA_API_VERSION, SOLA_REPORT_PAGE]).toEqual(["https://x1.cardknox.com/reportjson", "Report:All", "5.0.0", 1000]);
    expect(await c.transactions(B, B)).toEqual([{ xRefNum: "1" }]);
  });

  it("checks the times before sending", async () => {
    const { fetch, sent } = scripted(json(200, OK));
    const { c } = client(fetch);
    for (const [b, e] of [["2026-11-01", E], [B, "2026-11-30"], [`x${B}`, E], [B, `${E}x`], [E, B], ["2026-11-01T00:00:00", E]]) {
      await expect(c.transactions(b!, e!), `${b} ${e}`).rejects.toThrow("a report must run from one YYYY-MM-DD HH:MM:SS time to a later one");
    }
    await expect(c.transactions(E, B)).rejects.toBeInstanceOf(SolaApiError);
    expect(sent).toHaveLength(0);
  });

  it("says when the rows are missing", async () => {
    for (const answer of [json(200, {}), json(200, { xResult: "S" }), json(200, { xReportData: "a,b" }), json(200, null), json(200, []), text(200, "<html>")]) {
      await expect(client(scripted(answer).fetch).c.transactions(B, E)).rejects.toThrow("Sola answered the transaction report without its rows");
    }
  });

  it("says when Sola turns down the key, never repeating Sola's own words", async () => {
    for (const status of [401, 403]) await expect(client(scripted(json(status, {})).fetch).c.transactions(B, E)).rejects.toThrow(`Sola turned down SOLA_API_KEY (HTTP ${status})`);
    const key = await client(scripted(json(200, { xResult: "E", xError: `Invalid xKey ${KEY}`, xErrorCode: "00001" })).fetch).c.transactions(B, E).catch((e: Error) => e);
    expect(key).toBeInstanceOf(SolaConfigError);
    expect((key as Error).message).toBe("Sola turned down SOLA_API_KEY (code 00001)");
    await expect(client(scripted(json(200, { xResult: "E", xError: "Key is disabled" })).fetch).c.transactions(B, E)).rejects.toThrow(/^Sola turned down SOLA_API_KEY$/);
    const other = await client(scripted(json(200, { xResult: "E", xError: `Bad date for ${KEY}`, xErrorCode: "01463" })).fetch).c.transactions(B, E).catch((e: Error) => e);
    expect(other).toMatchObject({ name: "SolaApiError", status: 200, code: "01463", message: "Sola answered the transaction report with an error (code 01463)" });
    expect((other as Error).message).not.toContain(KEY);
    for (const xErrorCode of ["abc", "123456789", 5, undefined]) {
      const e = await client(scripted(json(200, { xResult: "E", xError: "Monkey business", xErrorCode })).fetch).c.transactions(B, E).catch((err: Error) => err);
      expect(e, String(xErrorCode)).toMatchObject({ message: "Sola answered the transaction report with an error", code: undefined });
    }
    for (const status of [400, 404, 501]) await expect(client(scripted(json(status, {})).fetch).c.transactions(B, E)).rejects.toMatchObject({ status, message: `Sola answered HTTP ${status} for the transaction report` });
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "5" }), json(500, {}), json(502, {}, { "retry-after": "600" }), json(503, {}), json(200, OK));
    const { c, slept } = client(fetch, { retries: 4 });
    expect(await c.transactions(B, E)).toEqual([]);
    expect(slept).toEqual([5000, 2000, 60_000, 8000]);
    expect(sent).toHaveLength(5);
    expect(sent.every((s) => s.body === sent[0]!.body)).toBe(true);
    const gave = client(scripted(json(504, {})).fetch);
    await expect(gave.c.transactions(B, E)).rejects.toMatchObject({ status: 504 });
    expect(gave.slept).toEqual([1000, 2000, 4000]);
    const zero = client(scripted(json(429, {}, { "retry-after": "0" }), json(200, OK)).fetch);
    await zero.c.transactions(B, E);
    expect(zero.slept).toEqual([1000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const once = scripted(json(400, {}));
    await expect(client(once.fetch).c.transactions(B, E)).rejects.toMatchObject({ status: 400 });
    expect(once.sent).toHaveLength(1);
    const none = scripted(json(500, {}), json(200, OK));
    await expect(client(none.fetch, { retries: 0 }).c.transactions(B, E)).rejects.toMatchObject({ status: 500 });
    expect(none.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(503, {}, { "retry-after": "0.001" }), json(200, OK));
    globalThis.fetch = fetch;
    try {
      expect(await solaClient({ apiKey: KEY }).transactions(B, E)).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
  });

  it("only ever posts Report:All to the reporting address", async () => {
    const mock = solaDocMock(account());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${c.url}`))).toEqual(new Set(["POST https://x1.cardknox.com/reportjson"]));
    expect(new Set(mock.reads.map((r) => r.xCommand))).toEqual(new Set(["Report:All"]));
  });
});

describe("Sola reading helpers", () => {
  it("reads amounts in whole cents", () => {
    for (const [v, c] of [["1250.00", 125_000], ["0.5", 50], ["-35.10", -3510], [" 7 ", 700], ["999999999999.99", 99_999_999_999_999]] as const) expect(solaCents(v)).toBe(c);
    for (const v of ["", "1.234", "1,250.00", "$5", "1e3", "1234567890123", 12.5, null]) expect(solaCents(v), String(v)).toBeUndefined();
  });

  it("reads Sola's times on the account's clock", () => {
    expect(solaTime("3/3/2022 7:36:34 AM", NY)).toEqual({ wall: "2022-03-03 07:36:34", iso: "2022-03-03T12:36:34.000Z" });
    expect(solaTime("7/4/2026 12:05:00 PM", NY)).toEqual({ wall: "2026-07-04 12:05:00", iso: "2026-07-04T16:05:00.000Z" });
    expect(solaTime("12/31/2025 12:00:00 am", "UTC")).toEqual({ wall: "2025-12-31 00:00:00", iso: "2025-12-31T00:00:00.000Z" });
    expect(solaTime(" 1/2/2026 11:59:59PM ", "America/Chicago")).toEqual({ wall: "2026-01-02 23:59:59", iso: "2026-01-03T05:59:59.000Z" });
    // In the hour the clock goes back, the earlier time; in the hour it skips, the time it would have been.
    expect(solaTime("11/1/2026 1:30:00 AM", NY)!.iso).toBe("2026-11-01T05:30:00.000Z");
    expect(solaTime("3/8/2026 2:30:00 AM", NY)!.iso).toBe("2026-03-08T06:30:00.000Z");
    expect(solaTime("3/8/2026 3:30:00 AM", NY)!.iso).toBe("2026-03-08T07:30:00.000Z");
    for (const v of ["2/30/2026 1:00:00 AM", "13/1/2026 1:00:00 AM", "1/1/2026 0:00:00 AM", "1/1/2026 13:00:00 PM", "1/1/2026 1:60:00 AM", "1/1/2026 1:00:60 AM", "1/1/2026 1:00 AM", "2026-01-01T00:00:00Z", "x1/1/2026 1:00:00 AM", 5, undefined]) {
      expect(solaTime(v, NY), String(v)).toBeUndefined();
    }
    expect(solaWallClock(Date.parse("2026-11-10T15:00:00.400Z"), NY)).toBe("2026-11-10 10:00:00");
    expect(solaWallClock(Date.parse("2026-07-01T03:00:00Z"), NY)).toBe("2026-06-30 23:00:00");
  });

  it("reads a row's fields whatever their casing", () => {
    expect(solaRow({ xRefNum: "1", XAMOUNT: "2", xamount: "3" })).toEqual({ xrefnum: "1", xamount: "3" });
    for (const v of [null, "x", [1], 5]) expect(solaRow(v)).toEqual({});
  });
});

describe("Sola events", () => {
  const row = () => {
    solaTransaction.reset();
    return solaTransaction.one();
  };

  it("logs a sale as Stripe and Authorize.net do, with the customer as a reference and no card, name or invoice", () => {
    const r = row();
    const read = solaTransactionEvent(r, ctx);
    expect(read).toMatchObject({ ok: true, wall: "2026-01-01 01:00:00" });
    expect(read.event).toMatchObject({ type: SOLA_CHARGE_EVENT, occurredAt: "2026-01-01T06:00:00.000Z", receivedAt: RECEIVED });
    expect(read.event!.payload).toEqual({
      chargeId: "sola_payments:transaction:600000001",
      system: "Sola Payments",
      amountCents: 125_000,
      currency: "USD",
      status: "succeeded",
      gatewayCommand: "cc:sale",
      gatewayResult: "approved",
      voided: false,
      method: "card",
      cardBrand: "visa",
      batchId: "sola_payments:batch:11000000",
      customerRefs: formCustomerRefs(CUSTOMER_KEY, { email: synthetic.email(1), phone: "2125550001" }).sort(),
      paid: true,
      captured: true,
    });
    expect(read.event!.payload.customerRefs).toHaveLength(2);
    const flat = JSON.stringify(read.event);
    for (const kept of ["4xxxxxxxxxxx1111", String(r.xToken), synthetic.name(1), synthetic.email(1), "2125550001", "INV-1", "Engagement ring"]) expect(flat).not.toContain(kept);
    expect([SOLA_CHARGE_EVENT, SOLA_REFUND_EVENT]).toEqual(["payment.charge_updated", "payment.refund_updated"]);
  });

  it("tells refunds, declines, voids, authorizations and checks apart", () => {
    const r = row();
    const payload = (o: Record<string, unknown>) => solaTransactionEvent({ ...r, ...o }, ctx).event!;
    for (const xCommand of ["cc:refund", "CC:Credit", "check:refund", "check:credit"]) {
      const e = payload({ xCommand, xAmount: "-35.00" });
      expect(e.type, xCommand).toBe(SOLA_REFUND_EVENT);
      expect(e.payload).toMatchObject({ refundId: "sola_payments:transaction:600000001", amountCents: 3500, status: "succeeded" });
      expect(e.payload).not.toHaveProperty("chargeId");
      expect(e.payload).not.toHaveProperty("paid");
    }
    for (const xCommand of ["cc:sale", "cc:capture", "cc:postauth", "check:sale"]) expect(payload({ xCommand }).payload, xCommand).toMatchObject({ status: "succeeded", paid: true, captured: true });
    expect(payload({ xCommand: "cc:authonly" }).payload).toMatchObject({ status: "pending", paid: false, captured: false });
    expect(payload({ xCommand: "check:sale" }).payload).toMatchObject({ method: "ach" });
    for (const xResponseResult of ["Declined", "Error", "", undefined]) expect(payload({ xResponseResult }).payload, String(xResponseResult)).toMatchObject({ status: "failed", paid: false });
    expect(payload({ xResponseResult: "Declined" }).payload.gatewayResult).toBe("declined");
    for (const xResponseResult of ["Approved!", "a".repeat(21), 5]) expect(payload({ xResponseResult }).payload.gatewayResult).toBe("unknown");
    for (const xVoid of ["1", 1, true]) expect(payload({ xVoid }).payload, String(xVoid)).toMatchObject({ status: "failed", voided: true });
    for (const xVoid of ["0", 0, false, "true"]) expect(payload({ xVoid }).payload.voided, String(xVoid)).toBe(false);
    expect(payload({ xVoid: "1" }).idempotencyKey).not.toBe(payload({}).idempotencyKey);
    for (const [xCardType, brand] of [["MasterCard", "mastercard"], ["Amex", "amex"], ["American Express", "amex"], ["Discover", "discover"], ["JCB", "jcb"], ["Diners Club", "diners"], ["Diners", "diners"], ["Visa", "visa"], ["Mystery", null], ["constructor", null], [5, null]] as const) {
      expect(payload({ xCardType }).payload.cardBrand, String(xCardType)).toBe(brand);
    }
    expect(payload({ xCurrency: "CAD" }).payload.currency).toBe("CAD");
    for (const xCurrency of ["cad", "CA", 5]) expect(payload({ xCurrency }).payload.currency).toBe("USD");
    for (const xResponseBatch of ["x", "", 5, "1".repeat(21)]) expect(payload({ xResponseBatch }).payload.batchId).toBeUndefined();
    expect(payload({ xEmail: undefined, xBillPhone: undefined }).payload.customerRefs).toEqual([]);
  });

  it("skips commands that aren't payments, keeping their time for paging", () => {
    const r = row();
    for (const xCommand of ["cc:save", "gift:issue", "ebtfs:balance", "cc:void", "fraud:submit"]) expect(solaTransactionEvent({ ...r, xCommand }, ctx), xCommand).toEqual({ ok: true, event: null, wall: "2026-01-01 01:00:00" });
  });

  it("is a duplicate when read again unchanged, and a new event when it changes", () => {
    const r = row();
    const a = solaTransactionEvent(r, ctx).event!;
    expect(solaTransactionEvent(structuredClone(r), { ...ctx, receivedAt: "2026-11-11T00:00:00.000Z" }).event!.idempotencyKey).toBe(a.idempotencyKey);
    expect(solaTransactionEvent({ ...r, xAmount: "1250.01" }, ctx).event!.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(a.idempotencyKey.slice(0, -13)).toBe("sola_payments:transaction:600000001");
    expect(a.idempotencyKey.slice(-13)).toMatch(/^:[0-9a-f]{12}$/);
    expect(a.id).toBe(a.idempotencyKey.replace(/:/g, "_"));
    // What isn't kept doesn't change the event.
    expect(solaTransactionEvent({ ...r, xInvoice: "other", xName: "Other" }, ctx).event!.idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a row it can't read, saying why", () => {
    const r = row();
    const bad = solaTransactionEvent("row", ctx);
    expect(bad).toMatchObject({ ok: false, wall: undefined });
    expect(bad.event).toMatchObject({ type: SOLA_CHARGE_EVENT, occurredAt: undefined, receivedAt: RECEIVED, payload: { system: "Sola Payments", transactionId: null } });
    expect(bad.event!.payload.problems).toEqual(["transaction has no reference number that reads", "transaction has no command", "transaction has no time that reads", "transaction has no amount that reads"]);
    expect(bad.event!.idempotencyKey).toMatch(/^sola_payments:unreadable_transaction:[0-9a-f]{12}$/);
    expect(bad.event!.id).toBe(bad.event!.idempotencyKey.replace(/:/g, "_"));
    for (const xRefNum of ["x", "", 5, "1".repeat(21)]) expect(solaTransactionEvent({ ...r, xRefNum }, ctx).event!.payload.problems, String(xRefNum)).toEqual(["transaction has no reference number that reads"]);
    expect(solaTransactionEvent({ ...r, xEnteredDate: "yesterday" }, ctx).event!.payload).toEqual({ system: "Sola Payments", transactionId: "600000001", problems: ["transaction has no time that reads"] });
    expect(solaTransactionEvent({ ...r, xAmount: "free" }, ctx).event!.payload.problems).toEqual(["transaction has no amount that reads"]);
    expect(solaTransactionEvent({ ...r, xCommand: "cc:refund", xAmount: "x" }, ctx).event!.type).toBe(SOLA_REFUND_EVENT);
    // Two unreadable rows apart only in what isn't kept still get their own keys.
    expect(solaTransactionEvent({ ...r, xRefNum: null, xName: "A" }, ctx).event!.idempotencyKey).not.toBe(solaTransactionEvent({ ...r, xRefNum: null, xName: "B" }, ctx).event!.idempotencyKey);
  });
});

describe("Sola checkpoint", () => {
  const pass = { until: "2026-11-10", begin: "2021-11-10 00:00:00" };
  const nextFrom = "2026-11-08";

  it("round-trips and turns down any other shape", () => {
    const c: SolaCursor = { pass, done: false, nextFrom };
    expect(parseSolaCursor(JSON.stringify(c))).toEqual(c);
    expect(parseSolaCursor(JSON.stringify({ pass: { ...pass, begin: "2026-02-28 23:59:59", extra: 1 }, done: true, nextFrom }))).toEqual({ pass: { ...pass, begin: "2026-02-28 23:59:59" }, done: true, nextFrom });
    expect(parseSolaCursor(JSON.stringify({ pass: null, done: true, nextFrom }))).toEqual({ pass: null, done: true, nextFrom });
    expect(parseSolaCursor(null)).toBeNull();
    for (const bad of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ pass: null, done: "yes", nextFrom }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-02-30" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "x2026-11-08" }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-08x" }),
      JSON.stringify({ done: true, nextFrom }),
      JSON.stringify({ pass: "x", done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, until: "2026-11-31" }, done: false, nextFrom }),
      JSON.stringify({ pass: { begin: pass.begin }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-11-10" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-11-10T00:00:00" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "x2021-11-10 00:00:00" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-11-10 00:00:00x" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-02-30 00:00:00" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-11-10 24:00:00" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-11-10 23:60:00" }, done: false, nextFrom }),
      JSON.stringify({ pass: { ...pass, begin: "2021-11-10 23:59:60" }, done: false, nextFrom }),
    ]) {
      expect(() => parseSolaCursor(bad), bad).toThrow("Sola checkpoint is not in the expected shape");
    }
  });
});

describe("Sola connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(solaDocMock(account())), expected: { ingested: 4 } });
    expect(result.full.ingested).toBe(4);
  });

  it("imports five years a month at a time, then stops for good", async () => {
    const mock = solaDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4);
    expect(mock.reads[0]).toEqual({ xVersion: "5.0.0", xSoftwareName: "KaratOS", xSoftwareVersion: "1.0", xCommand: "Report:All", xBeginDate: "2021-11-10 00:00:00", xEndDate: "2021-12-10 23:59:59", xGetNewest: false, xMaxRecords: 1000 });
    expect(mock.reads[1]).toMatchObject({ xBeginDate: "2021-12-11 00:00:00", xEndDate: "2022-01-10 23:59:59" });
    expect(mock.reads.at(-1)).toMatchObject({ xEndDate: "2026-11-10 23:59:59" });
    expect(mock.reads).toHaveLength(Math.ceil((Date.parse("2026-11-11") - Date.parse("2021-11-10")) / DAY_MS / SOLA_SPAN_DAYS));
    expect(SOLA_SPAN_DAYS).toBe(31);
    expect(parseSolaCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
  });

  it("pages within a span from the last row's time, keeping it in the checkpoint, and resumes there", async () => {
    solaTransaction.reset();
    const rows = solaTransaction.many(SOLA_REPORT_PAGE + 5, (n) => ({ xEnteredDate: solaEnteredDate(`2026-11-09 ${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00`) }));
    const data = account({ rows });
    const batches = await drain(connector(solaDocMock(data)).incrementalSync({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([1000, 6]);
    const last = solaTransactionEvent(rows[SOLA_REPORT_PAGE - 1], ctx).wall!;
    expect(batches.map((b) => parseSolaCursor(b.cursor ?? null))).toEqual([
      { pass: { until: "2026-11-10", begin: last }, done: false, nextFrom: "2026-11-08" },
      { pass: null, done: false, nextFrom: "2026-11-08" },
    ]);
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(solaDocMock(data)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(SOLA_REPORT_PAGE + 5);
    expect(report.duplicates).toBe(1);
    const resumed = solaDocMock(data);
    const rest = await drain(connector(resumed).incrementalSync({ cursor: batches[0]!.cursor ?? null } as never));
    expect(eventsOf(rest)).toHaveLength(6);
    expect(resumed.reads.map((r) => r.xBeginDate)).toEqual([last]);
  });

  it("moves a second on when a full page wouldn't move it, and counts skipped commands toward the page", async () => {
    const begins: string[] = [];
    const same = Array.from({ length: SOLA_REPORT_PAGE }, (_, n) => ({ xRefNum: String(n + 1), xCommand: n % 2 ? "cc:save" : "cc:sale", xAmount: "1.00", xEnteredDate: "11/9/2026 3:00:00 PM" }));
    const fake: SolaClient = { transactions: async (b) => (begins.push(b), begins.length === 1 ? same : []) };
    const batches = await drain(connector(solaDocMock(account()), { client: fake }).incrementalSync({ cursor: JSON.stringify({ pass: { until: "2026-11-10", begin: "2026-11-09 15:00:00" }, done: false, nextFrom: "2026-11-08" }) } as never));
    expect(begins).toEqual(["2026-11-09 15:00:00", "2026-11-09 15:00:01"]);
    expect(batches[0]!.events).toHaveLength(SOLA_REPORT_PAGE / 2);
    // A full page whose times don't read, or fall past the span, moves a second too.
    const odd: string[] = [];
    const junk = Array.from({ length: SOLA_REPORT_PAGE + 1 }, (_, n) => ({ xRefNum: String(n + 1), xCommand: "cc:sale", xAmount: "1.00", xEnteredDate: n ? "11/30/2030 3:00:00 PM" : "soon" }));
    const fake2: SolaClient = { transactions: async (b) => (odd.push(b), odd.length === 1 ? junk : []) };
    await drain(connector(solaDocMock(account()), { client: fake2 }).incrementalSync({ cursor: JSON.stringify({ pass: { until: "2026-11-10", begin: "2026-11-09 23:59:59" }, done: false, nextFrom: "2026-11-08" }) } as never));
    expect(odd).toEqual(["2026-11-09 23:59:59", "2026-11-10 00:00:00"]);
  });

  it("starts later syncs two days back, then from where each pass began, less two days", async () => {
    const data = account();
    const mock = solaDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    data.rows[0]!.xVoid = "1";
    const later = () => new Date(NOW().getTime() + 3 * DAY_MS);
    const before = mock.reads.length;
    // Each mode keeps its own checkpoint, so the first later sync looks back two days.
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.slice(before).map((r) => [r.xBeginDate, r.xEndDate])).toEqual([["2026-11-11 00:00:00", "2026-11-13 23:59:59"]]);
    expect(sync.ingested).toBe(0);
    expect(parseSolaCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-11" });
    expect(SOLA_OVERLAP_DAYS).toBe(2);
    const fresh = testPipeline();
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline: fresh.pipeline, memory: fresh.memory, organizationId: TEST_ORG });
    expect(first.ingested).toBe(1);
    const at = mock.reads.length;
    const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-10-01" }) } as never));
    expect(mock.reads[at]).toMatchObject({ xBeginDate: "2026-10-01 00:00:00", xEndDate: "2026-10-31 23:59:59" });
    expect(eventsOf(batches)).toHaveLength(2);
    // The next pass starts two days before this one, not where this one started.
    expect(parseSolaCursor(batches.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-08" });
  });

  it("resumes a later sync part way, keeping what it says of the import", async () => {
    for (const done of [true, false]) {
      const mock = solaDocMock(account());
      const batches = await drain(connector(mock).incrementalSync({ cursor: JSON.stringify({ pass: { until: "2026-11-09", begin: "2026-11-09 12:00:00" }, done, nextFrom: "2026-11-05" }) } as never));
      expect(mock.reads.map((r) => [r.xBeginDate, r.xEndDate])).toEqual([["2026-11-09 12:00:00", "2026-11-09 23:59:59"]]);
      expect(batches.map((b) => parseSolaCursor(b.cursor ?? null))).toEqual([{ pass: null, done, nextFrom: "2026-11-05" }]);
    }
    const batches = await drain(connector(solaDocMock(account())).incrementalSync({ cursor: JSON.stringify({ pass: null, done: true, nextFrom: "2026-09-20" }) } as never));
    expect(batches.map((b) => parseSolaCursor(b.cursor ?? null))).toEqual([
      { pass: { until: "2026-11-10", begin: "2026-10-21 00:00:00" }, done: true, nextFrom: "2026-11-08" },
      { pass: null, done: true, nextFrom: "2026-11-08" },
    ]);
  });

  it("reads the account's clock in the time zone it is given", async () => {
    const mock = solaDocMock(account());
    // 15:00 UTC is still the 10th in Chicago, and already past midnight in Tokyo.
    await drain(connector(mock, { timeZone: "Asia/Tokyo" }).incrementalSync({ cursor: null } as never));
    await drain(connector(mock, { timeZone: " America/Chicago " }).incrementalSync({ cursor: null } as never));
    await drain(connector(mock, { timeZone: "" }).incrementalSync({ cursor: null } as never));
    expect(mock.reads.map((r) => r.xEndDate)).toEqual(["2026-11-11 23:59:59", "2026-11-10 23:59:59", "2026-11-10 23:59:59"]);
    const late = () => new Date("2026-11-11T03:00:00.000Z");
    const nyLate = solaDocMock(account());
    await drain(connector(nyLate, { now: late }).incrementalSync({ cursor: null } as never));
    expect(nyLate.reads[0]).toMatchObject({ xBeginDate: "2026-11-08 00:00:00", xEndDate: "2026-11-10 23:59:59" });
    expect(SOLA_DEFAULT_TIME_ZONE).toBe(NY);
    expect(() => connector(mock, { timeZone: "Mars/Olympus" })).toThrow("SOLA_TIME_ZONE is not an IANA time zone such as America/New_York");
    expect(() => connector(mock, { timeZone: "Mars/Olympus" })).toThrow(SolaConfigError);
  });

  it("dead-letters what it can't read and carries on", async () => {
    const data = account();
    data.rows.push(solaTransaction.one({ xAmount: "free", xEnteredDate: enteredAgo(1) }));
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(solaDocMock(data)), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(1);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = solaDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    await drain(connector(mock, { sleep: async (ms) => void slept.push(ms) }).incrementalSync({ cursor: null } as never));
    expect(slept).toEqual([1000, 1000]);
  });

  it("stops on a turned-down key", async () => {
    await expect(drain(connector(solaDocMock(account({ apiKey: "z".repeat(20) }))).incrementalSync({ cursor: null } as never))).rejects.toThrow("Sola turned down SOLA_API_KEY (code 00001)");
  });

  it("checks its settings", () => {
    const mock = solaDocMock(account());
    expect(() => connector(mock, { customerKey: "short" })).toThrow("CUSTOMER_REF_KEY");
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears })).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { apiKey: "x" })).toThrow("SOLA_API_KEY");
    expect(() => connector(mock, { apiKey: "x", client: {} as SolaClient })).not.toThrow();
    expect(connector(mock).source).toBe("sola_payments");
  });

  it("reads back as far as told, and up to today when no clock is given", async () => {
    const mock = solaDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.xBeginDate).toBe("2025-11-10 00:00:00");
    const ends: string[] = [];
    const fake: SolaClient = { transactions: async (_b, e) => (ends.push(e), []) };
    await drain(solaConnector({ apiKey: KEY, customerKey: CUSTOMER_KEY, client: fake }).incrementalSync({ cursor: null } as never));
    expect(ends).toEqual([`${solaWallClock(Date.now(), NY).slice(0, 10)} 23:59:59`]);
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(SOLA_WRITES.map((w) => w.name)).toEqual(["create_payment_link", "create_recurring_schedule"]);
    const c = connector(solaDocMock(account()));
    expect(c.writes).toBe(SOLA_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "create_payment_link", integration: "sola_payments", outcome: "refused" },
      { action: "create_recurring_schedule", integration: "sola_payments", outcome: "refused" },
    ]);
  });
});

describe("Sola doc mock", () => {
  it("checks the key, the command, the dates and the page size", async () => {
    const mock = solaDocMock(account());
    const post = (body: Record<string, unknown> | string) => mock.fetch("https://x1.cardknox.com/reportjson", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
    const read = async (body: Record<string, unknown> | string) => (await (await post(body)).json()) as Record<string, unknown>;
    const base = { xKey: KEY, xVersion: "5.0.0", xSoftwareName: "test", xSoftwareVersion: "1", xCommand: "Report:All", xBeginDate: "2021-01-01", xEndDate: "2026-12-31" };
    expect(await read("nope")).toMatchObject({ xResult: "E", xErrorCode: "00002" });
    expect(await read({ ...base, xKey: "wrong" })).toMatchObject({ xResult: "E", xError: "Invalid xKey" });
    expect(await read({ ...base, xSoftwareName: "" })).toMatchObject({ xErrorCode: "00003" });
    expect(await read({ ...base, xCommand: "cc:sale" })).toMatchObject({ xErrorCode: "00004" });
    expect(await read({ ...base, xBeginDate: "1/1/2021" })).toMatchObject({ xErrorCode: "00005" });
    expect(await read({ ...base, xMaxRecords: 1001 })).toMatchObject({ xErrorCode: "00006" });
    expect(await read({ ...base, xBeginDate: "2026-11-09", xEndDate: "2026-11-09", xMaxRecords: 5000 })).toMatchObject({ xResult: "S" });
    expect(await read({ ...base, xCommand: "Report:Batch" })).toMatchObject({ xResult: "S", xReportData: [] });
    const all = await read(base);
    expect(all).toMatchObject({ xResult: "S", xRecordsReturned: "4", xReportingMaxTransactions: "1000" });
    const newest = await read({ ...base, xGetNewest: true, xMaxRecords: 1 });
    expect((newest.xReportData as Record<string, unknown>[])[0]!.xEnteredDate).toBe(enteredAgo(1));
    expect(mock.reads.every((r) => !("xKey" in r))).toBe(true);
  });
});
