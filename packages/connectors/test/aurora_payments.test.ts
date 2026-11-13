import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, auroraBatch, auroraDocMock, auroraTransaction, checkConnectorSync, testPipeline, type AuroraMock, type AuroraMockData, type AuroraMockRecord } from "@karatos/connector-testkit";
import {
  AURORA_EVENTS,
  AURORA_HOSTS,
  AURORA_OVERLAP_MS,
  AURORA_PAGE_SIZE,
  AURORA_WRITES,
  AuroraApiError,
  AuroraConfigError,
  auroraBatchEvent,
  auroraCents,
  auroraClient,
  auroraConnector,
  auroraRef,
  auroraTime,
  auroraTransactionEvent,
  parseAuroraCursor,
  type AuroraClient,
  type AuroraEvent,
  type AuroraOptions,
} from "../src/index.js";

// Shaped like a client ID and secret, assembled at runtime so no scanner mistakes the source for a leak.
const ID = ["test", "0".repeat(12)].join("-");
const SECRET = ["s", "0".repeat(31)].join("");
const API = "https://api.flute.com";
const OAUTH = "https://oauth.api.flute.com";
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const noSleep = async () => {};
const BASIC = `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`;
const ACCESS = `eyJ${"a".repeat(30)}`;

/** An ISO time `days` before NOW. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString();

/** Batches from 3 days, 400 days and six years ago, each with two transactions. */
function account(overrides: Partial<AuroraMockData> = {}): AuroraMockData {
  auroraBatch.reset();
  auroraTransaction.reset();
  const batches = [3, 400, 2200].map((d) => auroraBatch.one({ batchDateTime: ago(d) }));
  const transactions = batches.flatMap((b, i) => auroraTransaction.many(2, () => ({ batchId: b.id, date: ago([3, 400, 2200][i]! + 0.5) })));
  return { clientId: ID, clientSecret: SECRET, batches, transactions, ...overrides };
}

const connector = (mock: AuroraMock, overrides: Partial<AuroraOptions> = {}) => auroraConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as AuroraEvent[];

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
const token = (expires: unknown = 900, value: unknown = ACCESS) => json(200, { access_token: value, refresh_token: "r".repeat(20), token_type: "Bearer", expires_in: expires });
const items = (list: unknown[], total?: unknown) => json(200, total === undefined ? { items: list } : { items: list, total });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof auroraClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = auroraClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: async (ms) => void slept.push(ms), now: NOW, ...extra });
  return { c, slept };
};
const RANGE = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-11T15:00:00.000Z" };
const BATCH = "00000001-0000-4000-8000-000000000001";

describe("Aurora Payments client", () => {
  it("checks its client ID, secret and environment before sending anything", () => {
    const { fetch, sent } = scripted(token());
    const make = (o: Partial<Parameters<typeof auroraClient>[0]>) => () => auroraClient({ clientId: ID, clientSecret: SECRET, fetch, ...o });
    for (const clientId of ["", "   ", "x".repeat(7), "x".repeat(257), "has space", "id:colon", "id/slash", undefined as never]) expect(make({ clientId }), String(clientId)).toThrow(new AuroraConfigError("AURORA_CLIENT_ID is missing or not in the expected shape"));
    for (const clientSecret of ["", "x".repeat(15), "x".repeat(513), "has a space in it, so no", "tab\tin\tthe\tsecret\there", `${"x".repeat(15)}\x7f`, undefined as never]) expect(make({ clientSecret }), String(clientSecret)).toThrow(new AuroraConfigError("AURORA_CLIENT_SECRET is missing or not in the expected shape"));
    for (const environment of ["staging", "Sandbox", "", "toString", "__proto__"]) expect(make({ environment: environment as never }), environment).toThrow(new AuroraConfigError("AURORA_ENVIRONMENT must be production or sandbox"));
    expect(make({ clientId: "x".repeat(8), clientSecret: "!".repeat(16) })).not.toThrow();
    expect(make({ clientId: `${"Az09._~-".repeat(32)}`, clientSecret: "~".repeat(512) })).not.toThrow();
    expect(make({ clientId: ` ${ID} `, clientSecret: ` ${SECRET} ` })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("signs in with the key as trimmed", async () => {
    const { fetch, sent } = scripted(token(), items([]));
    await auroraClient({ clientId: ` ${ID}\n`, clientSecret: `\t${SECRET} `, fetch, now: NOW }).batches(RANGE, 0);
    expect(sent[0]!.headers.authorization).toBe(BASIC);
  });

  it("goes to production by default, or Flute's sandbox", () => {
    expect(AURORA_HOSTS).toEqual({ production: { api: "https://api.flute.com", oauth: "https://oauth.api.flute.com" }, sandbox: { api: "https://sandbox.api.flute.com", oauth: "https://sandbox.oauth.api.flute.com" } });
    expect(auroraClient({ clientId: ID, clientSecret: SECRET }).baseUrl).toBe(API);
    expect(auroraClient({ clientId: ID, clientSecret: SECRET, environment: "sandbox" }).baseUrl).toBe("https://sandbox.api.flute.com");
  });

  it("signs in with the key, then lists batches by date and a batch's transactions with GET only", async () => {
    const { fetch, sent } = scripted(token(), items([{ id: "b" }], 51), items([]));
    const { c } = client(fetch);
    expect(await c.batches(RANGE, 0)).toEqual({ items: [{ id: "b" }], more: true });
    await c.transactions(BATCH, 2);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${OAUTH}/oauth2/token`,
      `GET ${API}/pay-api/v1/settlements/batches?dateFrom=2026-11-01T00%3A00%3A00.000Z&dateTo=2026-11-11T15%3A00%3A00.000Z&orderBy=batchDateTime&asc=true&page=0&pageSize=50`,
      `GET ${API}/pay-api/v1/transactions?batchId=${BATCH}&orderBy=date&asc=true&page=2&pageSize=50`,
    ]);
    expect(sent[0]!.headers).toEqual({ authorization: BASIC, "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    expect(sent[0]!.body).toBe("grant_type=client_credentials&scope=offline_access");
    for (const s of sent.slice(1)) {
      expect(s.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: "application/json" });
      expect(s.body).toBeUndefined();
    }
  });

  it("keeps a token until a minute before it runs out, then signs in again", async () => {
    let clock = NOW().getTime();
    const { fetch, sent } = scripted(token(900), items([]), items([]), token(900, `${ACCESS}2`), items([]));
    const { c } = client(fetch, { now: () => new Date(clock) });
    await c.batches(RANGE, 0);
    clock += 839_000;
    await c.batches(RANGE, 0);
    clock += 1000;
    await c.batches(RANGE, 0);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    expect(sent[4]!.headers.authorization).toBe(`Bearer ${ACCESS}2`);
    // A lifetime that doesn't read counts as already run out.
    for (const expires of [0, -5, 1.5, "900", null, 86_401]) {
      const s = scripted(token(expires), items([]), token(expires), items([]));
      const one = client(s.fetch).c;
      await one.batches(RANGE, 0);
      await one.batches(RANGE, 0);
      expect(s.sent.filter((x) => x.method === "POST"), String(expires)).toHaveLength(2);
    }
    const day = scripted(token(86_400), items([]));
    const d = client(day.fetch).c;
    await d.batches(RANGE, 0);
    await d.batches(RANGE, 0);
    expect(day.sent.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("signs in again once when a token is turned down early, then gives up", async () => {
    const { fetch, sent } = scripted(token(), json(401, {}), token(900, `${ACCESS}2`), items([{ id: "b" }]));
    expect((await client(fetch).c.batches(RANGE, 0)).items).toHaveLength(1);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    const twice = scripted(token(), json(401, {}), token(), json(401, { details: "secret detail" }));
    const err = (await client(twice.fetch).c.batches(RANGE, 0).catch((e: Error) => e)) as AuroraConfigError;
    expect(err).toBeInstanceOf(AuroraConfigError);
    expect(err.message).toBe("Flute turned down the API key for settlement batches (HTTP 401); check it may list settlement batches");
    expect(twice.sent).toHaveLength(4);
    const forbidden = scripted(token(), json(403, {}));
    await expect(client(forbidden.fetch).c.transactions(BATCH, 0)).rejects.toThrow("Flute turned down the API key for transactions (HTTP 403); check it may list transactions");
    expect(forbidden.sent).toHaveLength(2);
  });

  it("says when Flute turns down the key or answers a sign-in oddly, never repeating Flute's words", async () => {
    for (const status of [400, 401, 403]) {
      const err = await client(scripted(json(status, { error: "secret detail" })).fetch).c.batches(RANGE, 0).catch((e: Error) => e);
      expect(err).toBeInstanceOf(AuroraConfigError);
      expect((err as Error).message).toBe(`Flute turned down AURORA_CLIENT_ID and AURORA_CLIENT_SECRET (HTTP ${status}); check the key is for production`);
    }
    await expect(client(scripted(json(401, {})).fetch, { environment: "sandbox" }).c.batches(RANGE, 0)).rejects.toThrow("check the key is for sandbox");
    const err = (await client(scripted(json(404, { error: "secret detail" })).fetch).c.batches(RANGE, 0).catch((e: Error) => e)) as AuroraApiError;
    expect(err).toBeInstanceOf(AuroraApiError);
    expect(err.message).toBe("Flute sign-in answered HTTP 404");
    await expect(client(scripted(json(201, { access_token: ACCESS, expires_in: 900 })).fetch).c.batches(RANGE, 0)).rejects.toThrow("Flute sign-in answered HTTP 201");
    expect(err.status).toBe(404);
    expect(err.name).toBe("AuroraApiError");
    expect(new AuroraConfigError("x").name).toBe("AuroraConfigError");
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), token(900, 5), token(900, 1.2345678901234568e21), token(900, "short"), token(900, "a".repeat(15)), token(900, `${"a".repeat(20)} b`), token(900, "a".repeat(8193))]) {
      const e = (await client(scripted(answer).fetch).c.batches(RANGE, 0).catch((x: Error) => x)) as AuroraApiError;
      expect(e.message).toBe("Flute sign-in answered without an access token");
      expect(e.status).toBe(200);
    }
    await expect(client(scripted(token(900, "a".repeat(8192)), items([])).fetch).c.batches(RANGE, 0)).resolves.toEqual({ items: [], more: false });
  });

  it("says when a list answers with an error or without its items", async () => {
    const err = (await client(scripted(token(), json(400, { details: "secret detail" })).fetch).c.batches(RANGE, 0).catch((e: Error) => e)) as AuroraApiError;
    expect(err.message).toBe("Flute answered HTTP 400 for settlement batches");
    expect(err.status).toBe(400);
    await expect(client(scripted(token(), json(201, { items: [] })).fetch).c.transactions(BATCH, 0)).rejects.toThrow("Flute answered HTTP 201 for transactions");
    for (const answer of [text(200, "not json"), json(200, null), json(200, {}), json(200, []), json(200, { items: {} }), json(200, { data: [] })]) {
      const e = (await client(scripted(token(), answer).fetch).c.transactions(BATCH, 0).catch((x: Error) => x)) as AuroraApiError;
      expect(e.message).toBe("Flute answered without a list of transactions");
      expect(e.status).toBe(200);
    }
  });

  it("works out whether more pages follow from the total, or a full page without one", async () => {
    const more = async (answer: () => Response, page = 0) => (await client(scripted(token(), answer).fetch).c.batches(RANGE, page)).more;
    const full = Array.from({ length: AURORA_PAGE_SIZE }, (_, i) => ({ id: String(i) }));
    expect(AURORA_PAGE_SIZE).toBe(50);
    expect(await more(items(full, 100))).toBe(true);
    expect(await more(items(full, 100), 1)).toBe(false);
    expect(await more(items(full, 101), 1)).toBe(true);
    expect(await more(items([{ id: "1" }], 1))).toBe(false);
    expect(await more(items([], 0))).toBe(false);
    for (const total of [undefined, "100", 1.5, null]) {
      expect(await more(items(full, total)), String(total)).toBe(true);
      expect(await more(items(full.slice(1), total)), String(total)).toBe(false);
    }
  });

  it("checks what it is asked for before sending", async () => {
    const { fetch, sent } = scripted(token(), items([]));
    const { c } = client(fetch);
    for (const page of [-1, 1.5, Number.NaN, "1" as never]) {
      await expect(c.batches(RANGE, page), String(page)).rejects.toThrow(new AuroraApiError("page must be a whole number, 0 or more", 0));
      await expect(c.transactions(BATCH, page), String(page)).rejects.toThrow("page must be a whole number, 0 or more");
    }
    for (const range of [
      { from: "2026-11-01", to: RANGE.to },
      { from: RANGE.from, to: "2026-11-11T15:00:00Z" },
      { from: RANGE.to, to: RANGE.from },
      { from: ` ${RANGE.from}`, to: RANGE.to },
      { from: RANGE.from, to: `${RANGE.to}x` },
      { from: `x${RANGE.from}`, to: RANGE.to },
    ])
      await expect(c.batches(range, 0), JSON.stringify(range)).rejects.toThrow("batches are listed between two UTC times");
    await expect(c.batches({ from: RANGE.to, to: RANGE.to }, 0)).resolves.toBeDefined();
    for (const id of ["", "a/b", "a&b=c", "a b", "x".repeat(65), "a.b"]) await expect(c.transactions(id, 0), id).rejects.toThrow("not a settlement batch ID");
    expect(sent).toHaveLength(2);
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const { fetch, sent } = scripted(json(status, {}, { "retry-after": "2" }), token(), json(status, {}), items([{ id: "b" }]));
      const { c, slept } = client(fetch);
      expect((await c.batches(RANGE, 0)).items).toHaveLength(1);
      expect(sent).toHaveLength(4);
      expect(slept, String(status)).toEqual([2000, 1000]);
    }
    const { fetch, sent } = scripted(token(), json(429, {}, { "retry-after": "600" }), json(429, {}), json(429, {}, { "retry-after": "0" }), json(429, {}, { "retry-after": "soon" }));
    const { c, slept } = client(fetch);
    await expect(c.batches(RANGE, 0)).rejects.toThrow("Flute answered HTTP 429 for settlement batches");
    expect(sent).toHaveLength(5);
    expect(slept).toEqual([60_000, 2000, 4000]);
    const down = scripted(json(503, {}));
    await expect(client(down.fetch).c.batches(RANGE, 0)).rejects.toThrow("Flute sign-in answered HTTP 503");
    expect(down.sent).toHaveLength(4);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    for (const status of [400, 404, 422, 501]) {
      const { fetch, sent } = scripted(token(), json(status, {}), items([]));
      await expect(client(fetch).c.batches(RANGE, 0)).rejects.toThrow(`HTTP ${status}`);
      expect(sent).toHaveLength(2);
    }
    const { fetch, sent } = scripted(token(), json(503, {}));
    await expect(client(fetch, { retries: 1 }).c.batches(RANGE, 0)).rejects.toThrow("HTTP 503");
    expect(sent).toHaveLength(3);
    const once = scripted(token(), json(503, {}));
    await expect(client(once.fetch, { retries: 0 }).c.batches(RANGE, 0)).rejects.toThrow("HTTP 503");
    expect(once.sent).toHaveLength(2);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(token(), json(429, {}, { "retry-after": "0.01" }), items([]));
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      const c = auroraClient({ clientId: ID, clientSecret: SECRET });
      await c.batches(RANGE, 0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(5);
      await c.batches(RANGE, 0);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "GET"]);
  });
});

describe("Aurora Payments reading helpers", () => {
  it("reads Flute's times as UTC", () => {
    expect(auroraTime("2026-02-19T20:24:52.934Z")).toBe("2026-02-19T20:24:52.934Z");
    expect(auroraTime("2025-01-27T12:05:54.322587Z")).toBe("2025-01-27T12:05:54.322Z");
    expect(auroraTime("2025-01-27T12:05:54.3225879Z")).toBe("2025-01-27T12:05:54.322Z");
    expect(auroraTime("2026-02-19T20:24:52-05:00")).toBe("2026-02-20T01:24:52.000Z");
    expect(auroraTime("2026-02-19T20:24:52.5+01:00")).toBe("2026-02-19T19:24:52.500Z");
    for (const bad of ["2026-02-19", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-02-19T24:00:00Z", "2026-02-19T20:60:00Z", "2026-02-19T20:24:52.12345678Z", "2026-02-19T20:24Z", "2026-02-19T20:24:52+0500", " 2026-02-19T20:24:52Z", "2026-02-19T20:24:52Zx", "", null, 1_771_532_692]) expect(auroraTime(bad), String(bad)).toBeUndefined();
  });

  it("reads a time with no zone as UTC wherever the server is", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(auroraTime("2026-02-19T20:24:52")).toBe("2026-02-19T20:24:52.000Z");
    } finally {
      process.env.TZ = tz;
    }
  });

  it("turns down a time without its T", () => {
    expect(auroraTime("2026-01-0212:00:00Z")).toBeUndefined();
    expect(auroraTime("2026-01-02")).toBeUndefined();
  });

  it("reads dollars as cents", () => {
    expect(auroraCents(1299.75)).toBe(129_975);
    expect(auroraCents(0.005)).toBe(1);
    expect(auroraCents(-0.005)).toBe(-1);
    expect(auroraCents(-50)).toBe(-5000);
    expect(auroraCents(0)).toBe(0);
    expect(auroraCents(999_999_999_999.99)).toBe(99_999_999_999_999);
    for (const bad of ["12.50", null, undefined, true, Number.NaN, Number.POSITIVE_INFINITY, 1e12, -1e12]) expect(auroraCents(bad), String(bad)).toBeNull();
  });

  it("makes references", () => {
    expect(auroraRef("batch", "abc")).toBe("aurora:batch:abc");
  });
});

describe("Aurora Payments events", () => {
  const ctx = { receivedAt: RECEIVED };
  const one = (b: { reset(): void; one(o?: AuroraMockRecord): AuroraMockRecord }, o: AuroraMockRecord = {}) => {
    b.reset();
    return b.one(o);
  };

  it("names an event type for each record", () => {
    expect(AURORA_EVENTS).toEqual({ batch: "payout.updated", transaction: "balance.transaction_recorded" });
  });

  it("keeps a batch's number, totals and status", () => {
    const e = auroraBatchEvent(one(auroraBatch), ctx);
    expect(e.type).toBe("payout.updated");
    expect(e.occurredAt).toBe("2026-01-02T20:00:00.000Z");
    expect(e.receivedAt).toBe(RECEIVED);
    expect(e.payload).toStrictEqual({
      system: "Aurora Payments",
      payoutId: `aurora:batch:${BATCH}`,
      processorBatchNumber: "0004821001",
      processor: "Test Processor",
      status: "settled",
      transactionCount: 2,
      salesCents: 129_975,
      refundsCents: 5000,
      amountCents: 124_975,
      currency: "USD",
      occurredAt: "2026-01-02T20:00:00.000Z",
    });
    expect(e.idempotencyKey).toMatch(new RegExp(`^aurora:batch:${BATCH}:[0-9a-f]{12}$`));
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    expect(auroraBatchEvent(one(auroraBatch, { statusId: 1 }), ctx).payload.status).toBe("open");
    for (const [statusId, word] of [[0, "unknown"], [3, "unknown"], [1.5, null], ["2", null]] as const) expect(auroraBatchEvent(one(auroraBatch, { statusId }), ctx).payload.status, String(statusId)).toBe(word);
    expect(auroraBatchEvent(one(auroraBatch, { externalBatchId: ` ${"9".repeat(50)} `, paymentProcessorName: "  ", transactionCount: -1, netAmount: "1249.75", salesAmount: null, refundsAmount: 0 }), ctx).payload).toMatchObject({
      processorBatchNumber: "9".repeat(40),
      processor: null,
      transactionCount: null,
      amountCents: null,
      salesCents: null,
      refundsCents: 0,
    });
    expect(auroraBatchEvent(one(auroraBatch, { transactionCount: 1.5 }), ctx).payload.transactionCount).toBeNull();
    expect(auroraBatchEvent(one(auroraBatch, { transactionCount: 0, paymentProcessorName: "P".repeat(70) }), ctx).payload).toMatchObject({ transactionCount: 0, processor: "P".repeat(60) });
  });

  it("keeps a transaction's type, status and amounts under its batch, and nothing about the customer", () => {
    const e = auroraTransactionEvent(one(auroraTransaction), { ...ctx, batchId: BATCH.toUpperCase() });
    expect(e.type).toBe("balance.transaction_recorded");
    expect(e.occurredAt).toBe("2026-01-01T01:00:00.000Z");
    expect(e.payload).toStrictEqual({
      system: "Aurora Payments",
      transactionId: "aurora:transaction:00000002-0000-4000-8000-000000000001",
      payoutId: `aurora:batch:${BATCH}`,
      transactionType: "sale",
      status: "Captured",
      paymentMethod: "card",
      source: "Terminal",
      currency: "USD",
      baseCents: 120_000,
      totalCents: 129_975,
      surchargeCents: 0,
      taxCents: 9975,
      tipCents: 0,
      discountCents: 0,
      cashDiscountCents: 0,
      occurredAt: "2026-01-01T01:00:00.000Z",
    });
    const all = JSON.stringify(e);
    for (const hidden of ["Test Customer", "Test Company", "4242", "example.test", "5550100", "Test Jeweler", "Front counter", "Counter terminal"]) expect(all, hidden).not.toContain(hidden);
    const types = ["authorization", "sale", "capture", "void", "refund", "verify"];
    for (const [i, word] of types.entries()) expect(auroraTransactionEvent(one(auroraTransaction, { typeId: i + 1 }), { ...ctx, batchId: BATCH }).payload.transactionType).toBe(word);
    const odd = auroraTransactionEvent(one(auroraTransaction, { typeId: 7, paymentMethodTypeId: 2, currencyCode: "usd", status: "S".repeat(50), source: null, amount: { taxAmount: 1, tipAmount: 14.5, percentageOffAmount: 12.5, cashDiscountAmount: 10.55 }, surchargeAmount: 6.45 }), { ...ctx, batchId: BATCH }).payload;
    expect(odd).toMatchObject({ transactionType: "unknown", paymentMethod: "ach", currency: null, status: "S".repeat(40), source: null, taxCents: 100, tipCents: 1450, discountCents: 1250, cashDiscountCents: 1055, surchargeCents: 645 });
    const none = auroraTransactionEvent(one(auroraTransaction, { typeId: "2", paymentMethodTypeId: 3, currencyCode: "USDX", amount: null, source: { type: "T".repeat(50) } }), { ...ctx, batchId: BATCH }).payload;
    expect(none).toMatchObject({ transactionType: null, paymentMethod: "unknown", currency: null, taxCents: null, tipCents: null, source: "T".repeat(40) });
    expect(auroraTransactionEvent(one(auroraTransaction, { currencyCode: 840 }), { ...ctx, batchId: BATCH }).payload.currency).toBeNull();
    expect(auroraTransactionEvent(one(auroraTransaction, { currencyCode: ["USD"] }), { ...ctx, batchId: BATCH }).payload.currency).toBeNull();
    // The batch is the one it was listed under, read in either case.
    expect(auroraTransactionEvent(one(auroraTransaction, { batchId: "other" }), { ...ctx, batchId: "Ab-9" }).payload.payoutId).toBe("aurora:batch:ab-9");
  });

  it("keys each version by what was kept, so an unchanged one is a duplicate", () => {
    const a = auroraBatchEvent(one(auroraBatch, { statusId: 1 }), ctx);
    expect(auroraBatchEvent(one(auroraBatch, { statusId: 1 }), { receivedAt: "2027-01-01T00:00:00.000Z" }).idempotencyKey).toBe(a.idempotencyKey);
    expect(auroraBatchEvent(one(auroraBatch), ctx).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(auroraBatchEvent(one(auroraBatch, { statusId: 1, statusName: "other", paymentProcessorId: "x" }), ctx).idempotencyKey).toBe(a.idempotencyKey);
    const t = auroraTransactionEvent(one(auroraTransaction), { ...ctx, batchId: BATCH });
    expect(auroraTransactionEvent(one(auroraTransaction, { customerName: "Other" }), { ...ctx, batchId: BATCH }).idempotencyKey).toBe(t.idempotencyKey);
    expect(t.idempotencyKey).toMatch(/^aurora:transaction:00000002-0000-4000-8000-000000000001:[0-9a-f]{12}$/);
    // An ID is read the same in either case.
    expect(auroraBatchEvent(one(auroraBatch, { id: BATCH.toUpperCase(), statusId: 1 }), ctx).idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a record that doesn't read, listing why", () => {
    const e = auroraBatchEvent({ id: "a/b", batchDateTime: "soon" }, ctx);
    expect(e.occurredAt).toBeUndefined();
    expect(e.type).toBe("payout.updated");
    expect(e.payload).toEqual({ system: "Aurora Payments", payoutId: null, problems: ["batch has no ID that reads", "batch has no time that reads"] });
    expect(e.idempotencyKey).toMatch(/^aurora:unreadable_batch:[0-9a-f]{12}$/);
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    // Two that read the same way are still two records.
    expect(auroraBatchEvent({ id: "a/c", batchDateTime: "soon" }, ctx).idempotencyKey).not.toBe(e.idempotencyKey);
    expect(auroraTransactionEvent({ id: "T1" }, { ...ctx, batchId: BATCH }).payload).toEqual({ system: "Aurora Payments", transactionId: "aurora:transaction:t1", problems: ["transaction has no time that reads"] });
    for (const id of ["", 5, "x".repeat(65), null]) expect(auroraBatchEvent({ id, batchDateTime: "2026-01-01T00:00:00Z" }, ctx).payload.problems, String(id)).toEqual(["batch has no ID that reads"]);
    expect(auroraBatchEvent({ id: "x".repeat(64), batchDateTime: "2026-01-01T00:00:00Z" }, ctx).payload.problems).toBeUndefined();
    for (const raw of [null, "x", []]) expect(auroraTransactionEvent(raw, { ...ctx, batchId: BATCH }).payload.problems, JSON.stringify(raw)).toHaveLength(2);
    // One whose time reads keeps it.
    expect(auroraBatchEvent({ id: "a/b", batchDateTime: "2026-01-01T00:00:00Z" }, ctx).occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("Aurora Payments checkpoint", () => {
  const S = "2021-11-11T15:00:00.000Z";
  const E = "2026-11-11T15:00:00.000Z";
  const N = "2026-11-04T15:00:00.000Z";
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    expect(parseAuroraCursor(null)).toBeNull();
    expect(parseAuroraCursor(JSON.stringify({ pass: { start: S, end: E, offset: 5 }, done: false, nextFrom: N }))).toEqual({ pass: { start: S, end: E, offset: 5 }, done: false, nextFrom: N });
    expect(parseAuroraCursor(JSON.stringify({ pass: { start: E, end: E, offset: 0 }, done: true, nextFrom: N }))).toEqual({ pass: { start: E, end: E, offset: 0 }, done: true, nextFrom: N });
    expect(parseAuroraCursor(JSON.stringify({ pass: null, done: true, nextFrom: N, extra: 1 }))).toEqual({ pass: null, done: true, nextFrom: N });
    for (const bad of [
      "not json",
      "null",
      "[]",
      "3",
      JSON.stringify({ pass: null, done: "yes", nextFrom: N }),
      JSON.stringify({ pass: null, nextFrom: N }),
      JSON.stringify({ pass: null, done: true }),
      JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-04T15:00:00Z" }),
      JSON.stringify({ done: true, nextFrom: N }),
      JSON.stringify({ pass: "x", done: true, nextFrom: N }),
      JSON.stringify({ pass: [], done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: E, end: S, offset: 0 }, done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: "2021-11-11", end: E, offset: 0 }, done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: S, end: "2026-11-11", offset: 0 }, done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: S, end: E, offset: -1 }, done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: S, end: E, offset: 1.5 }, done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: S, end: E, offset: "5" }, done: true, nextFrom: N }),
      JSON.stringify({ pass: { start: S, end: E }, done: true, nextFrom: N }),
    ])
      expect(() => parseAuroraCursor(bad), bad).toThrow("Aurora Payments checkpoint is not in the expected shape");
  });
});

describe("Aurora Payments connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(auroraDocMock(account())), expected: { ingested: 6 } });
    expect(result.full.ingested).toBe(6);
  });

  it("imports five years of batches, each with its transactions, then stops for good", async () => {
    const mock = auroraDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(mock.signIns).toBe(1);
    expect(mock.reads.map((r) => [r.path, r.query.batchId ?? r.query.dateFrom])).toEqual([
      ["/pay-api/v1/settlements/batches", "2021-11-11T15:00:00.000Z"],
      ["/pay-api/v1/transactions", "00000001-0000-4000-8000-000000000002"],
      ["/pay-api/v1/transactions", "00000001-0000-4000-8000-000000000001"],
    ]);
    expect(mock.reads[0]!.query).toEqual({ dateFrom: "2021-11-11T15:00:00.000Z", dateTo: "2026-11-11T15:00:00.000Z", orderBy: "batchDateTime", asc: "true", page: "0", pageSize: "50" });
    expect(parseAuroraCursor(report.cursor)).toEqual({ pass: null, done: true, nextFrom: "2026-11-04T15:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(3);
  });

  it("makes each batch with its transactions one batch, keeping how far the pass has read, and resumes there", async () => {
    auroraBatch.reset();
    auroraTransaction.reset();
    const batches = auroraBatch.many(53, (n) => ({ batchDateTime: ago(60 - n) }));
    const transactions = auroraTransaction.many(52, () => ({ batchId: batches[0]!.id, date: ago(60) }));
    const data: AuroraMockData = { clientId: ID, clientSecret: SECRET, batches, transactions };
    const all = await drain(connector(auroraDocMock(data)).historicalImport({ cursor: null } as never));
    expect(all).toHaveLength(53);
    expect(all.map((b) => b.events.length)).toEqual([53, ...Array(52).fill(1)]);
    const cursors = all.map((b) => parseAuroraCursor(b.cursor ?? null)!);
    expect(cursors.slice(0, 2).map((c) => c.pass?.offset)).toEqual([1, 2]);
    expect(cursors[49]!.pass!.offset).toBe(50);
    expect(cursors.at(-1)).toEqual({ pass: null, done: true, nextFrom: "2026-11-04T15:00:00.000Z" });
    expect(cursors.slice(0, -1).every((c) => !c.done)).toBe(true);
    // Resumed a day later after 51 batches, the pass goes on with the 52nd, on the second page.
    const resumed = auroraDocMock(data);
    const rest = await drain(connector(resumed, { now: () => new Date(NOW().getTime() + DAY_MS) }).historicalImport({ cursor: all[50]!.cursor ?? null } as never));
    expect(rest).toHaveLength(2);
    expect(resumed.reads.filter((r) => r.path.endsWith("batches")).map((r) => [r.query.page, r.query.dateFrom])).toEqual([["1", cursors[0]!.pass!.start]]);
    expect(eventsOf(rest).map((e) => e.payload.payoutId)).toEqual([`aurora:batch:${batches[51]!.id}`, `aurora:batch:${batches[52]!.id}`]);
    expect(eventsOf(rest)[0]!.receivedAt).toBe("2026-11-12T15:00:00.000Z");
    expect(parseAuroraCursor(rest.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-04T15:00:00.000Z" });
    expect(new Set(eventsOf(all).map((e) => e.idempotencyKey)).size).toBe(105);
  });

  it("ends a pass on an empty page, with or without a total", async () => {
    const empty = await drain(connector(auroraDocMock(account({ batches: [] }))).historicalImport({ cursor: null } as never));
    expect(empty.map((b) => [b.events.length, parseAuroraCursor(b.cursor ?? null)])).toEqual([[0, { pass: null, done: true, nextFrom: "2026-11-04T15:00:00.000Z" }]]);
    // A pass resumed at the end of a full page, where no more follow.
    const pages: number[] = [];
    const fake: AuroraClient = {
      baseUrl: API,
      batches: async (_r, page) => (pages.push(page), page === 0 ? { items: Array.from({ length: 50 }, () => ({})), more: true } : { items: [], more: false }),
      transactions: async () => ({ items: [], more: false }),
    };
    const resume = JSON.stringify({ pass: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z", offset: 50 }, done: false, nextFrom: "2026-01-25T00:00:00.000Z" });
    const ended = await drain(auroraConnector({ client: fake, now: NOW }).historicalImport({ cursor: resume } as never));
    expect(pages).toEqual([1]);
    expect(ended.map((b) => parseAuroraCursor(b.cursor ?? null))).toEqual([{ pass: null, done: true, nextFrom: "2026-01-25T00:00:00.000Z" }]);
  });

  it("resumes across pages, skips an empty page that says more follow, and keeps what it knew of the import", async () => {
    const at = "2026-01-02T00:00:00Z";
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${from + i}`, batchDateTime: at }));
    const asked: number[] = [];
    const fake = (pages: { items: unknown[]; more: boolean }[]): AuroraClient => ({
      baseUrl: API,
      batches: async (_r, p) => (asked.push(p), pages[p] ?? { items: [], more: false }),
      transactions: async () => ({ items: [], more: false }),
    });
    const pass = { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" };
    const cursor = (offset: number, done: boolean) => JSON.stringify({ pass: { ...pass, offset }, done, nextFrom: "2026-01-25T00:00:00.000Z" });
    const two = await drain(auroraConnector({ client: fake([{ items: page(0, 50), more: true }, { items: page(50, 50), more: false }]), now: NOW }).historicalImport({ cursor: cursor(3, false) } as never));
    expect(eventsOf(two).map((e) => e.payload.payoutId)).toEqual(Array.from({ length: 97 }, (_, i) => `aurora:batch:b${i + 3}`));
    expect(parseAuroraCursor(two.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-01-25T00:00:00.000Z" });
    asked.length = 0;
    const gap = await drain(auroraConnector({ client: fake([{ items: [], more: true }, { items: page(0, 1), more: false }]), now: NOW }).historicalImport({ cursor: null } as never));
    expect(asked).toEqual([0, 1]);
    expect(eventsOf(gap)).toHaveLength(1);
    // A later sync resumed mid-pass after the import ended says so at every checkpoint.
    const later = await drain(auroraConnector({ client: fake([{ items: page(0, 2), more: false }]), now: NOW }).incrementalSync({ cursor: cursor(0, true) } as never));
    expect(later.map((b) => parseAuroraCursor(b.cursor ?? null)!.done)).toEqual([true, true]);
    // An empty later pass before the import ends doesn't say it ended.
    const quiet = await drain(auroraConnector({ client: fake([]), now: NOW }).incrementalSync({ cursor: JSON.stringify({ pass: null, done: false, nextFrom: "2026-11-01T00:00:00.000Z" }) } as never));
    expect(quiet.map((b) => parseAuroraCursor(b.cursor ?? null))).toEqual([{ pass: null, done: false, nextFrom: "2026-11-04T15:00:00.000Z" }]);
    // The import, once done, reads nothing, even with a later pass under way.
    asked.length = 0;
    expect(await drain(auroraConnector({ client: fake([{ items: page(0, 2), more: false }]), now: NOW }).historicalImport({ cursor: cursor(0, true) } as never))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("lists the batches from a week before the last pass on each later sync, reading a settled one again", async () => {
    const data = account();
    data.batches[0]!.statusId = 1;
    const mock = auroraDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(AURORA_OVERLAP_MS).toBe(7 * DAY_MS);
    // Each mode keeps its own checkpoint, so the first later sync looks back a week.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads[3]!.query).toMatchObject({ dateFrom: "2026-11-04T15:00:00.000Z", dateTo: "2026-11-11T15:00:00.000Z" });
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(3);
    expect(parseAuroraCursor(first.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-04T15:00:00.000Z" });
    // The open batch settles.
    data.batches[0]!.statusId = 2;
    const later = () => new Date(NOW().getTime() + DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-2)!.query).toMatchObject({ dateFrom: "2026-11-04T15:00:00.000Z", dateTo: "2026-11-12T15:00:00.000Z" });
    expect(sync.ingested).toBe(1);
    expect(parseAuroraCursor(sync.cursor)).toEqual({ pass: null, done: false, nextFrom: "2026-11-05T15:00:00.000Z" });
    // A later sync resumed mid-pass keeps its dates and what it knew of the import.
    const mid = JSON.stringify({ pass: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-10T00:00:00.000Z", offset: 0 }, done: true, nextFrom: "2026-11-03T00:00:00.000Z" });
    const resumed = auroraDocMock(data);
    const rest = await drain(connector(resumed).incrementalSync({ cursor: mid } as never));
    expect(resumed.reads[0]!.query).toMatchObject({ dateFrom: "2026-11-01T00:00:00.000Z", dateTo: "2026-11-10T00:00:00.000Z" });
    expect(rest.map((b) => parseAuroraCursor(b.cursor ?? null))).toEqual([{ pass: null, done: true, nextFrom: "2026-11-03T00:00:00.000Z" }]);
    const midImport = JSON.stringify({ pass: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-10T00:00:00.000Z", offset: 0 }, done: false, nextFrom: "2026-11-03T00:00:00.000Z" });
    const ended = await drain(connector(auroraDocMock(data)).incrementalSync({ cursor: midImport } as never));
    expect(parseAuroraCursor(ended.at(-1)!.cursor ?? null)!.done).toBe(false);
    // A later sync after the import ended keeps saying so.
    const doneCursor = JSON.stringify({ pass: null, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const after = await drain(connector(auroraDocMock(data)).incrementalSync({ cursor: doneCursor } as never));
    expect(parseAuroraCursor(after.at(-1)!.cursor ?? null)).toEqual({ pass: null, done: true, nextFrom: "2026-11-04T15:00:00.000Z" });
    expect(eventsOf(after)).toHaveLength(3);
  });

  it("dead-letters a batch or transaction that doesn't read and keeps going, still reading a batch's transactions by its ID", async () => {
    auroraBatch.reset();
    auroraTransaction.reset();
    const batches = [auroraBatch.one({ batchDateTime: "soon" }), auroraBatch.one({ batchDateTime: "soon", id: "not/an/id" }), auroraBatch.one({ batchDateTime: ago(3) })];
    const read: string[] = [];
    const fake: AuroraClient = {
      baseUrl: API,
      batches: async () => ({ items: batches, more: false }),
      transactions: async (id) => (read.push(id), { items: id === batches[2]!.id ? [auroraTransaction.one({ date: null }), auroraTransaction.one({ date: ago(3) })] : [], more: false }),
    };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: auroraConnector({ client: fake, now: NOW }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(read).toEqual([batches[0]!.id, batches[2]!.id]);
    expect(report.deadLettered).toBe(3);
    expect(report.ingested).toBe(2);
  });

  it("waits out a rate limit inside a sync, and signs in again when a token is turned down", async () => {
    const mock = auroraDocMock(account({ rateLimits: 2, expireTokens: 1 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(6);
    expect(slept).toEqual([1000, 1000]);
    expect(mock.signIns).toBe(2);
  });

  it("says when Flute turns the key down, or a list it may not read, reading nothing", async () => {
    const wrong = auroraDocMock(account({ clientSecret: `${SECRET}1` }));
    await expect(drain(connector(wrong).historicalImport({ cursor: null } as never))).rejects.toThrow("Flute turned down AURORA_CLIENT_ID and AURORA_CLIENT_SECRET (HTTP 401); check the key is for production");
    expect(wrong.reads).toHaveLength(0);
    const limited = auroraDocMock(account({ forbidden: ["transactions"] }));
    await expect(drain(connector(limited).historicalImport({ cursor: null } as never))).rejects.toThrow("Flute turned down the API key for transactions (HTTP 403)");
  });

  it("checks its options, reading a blank or mixed-case environment", async () => {
    const mock = auroraDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    expect(() => connector(mock, { environment: "staging" })).toThrow("AURORA_ENVIRONMENT must be production or sandbox");
    expect(() => connector(mock, { clientId: undefined })).toThrow("AURORA_CLIENT_ID is missing");
    expect(() => connector(mock, { clientSecret: undefined })).toThrow("AURORA_CLIENT_SECRET is missing");
    expect(() => connector(mock, { clientId: "x", client: {} as AuroraClient })).not.toThrow();
    expect(connector(mock).source).toBe("aurora_payments");
    for (const environment of [" Sandbox ", "SANDBOX"]) {
      const sandbox = auroraDocMock(account({ sandbox: true }));
      expect(eventsOf(await drain(connector(sandbox, { environment }).historicalImport({ cursor: null } as never))), environment).toHaveLength(6);
    }
    for (const environment of ["", "  ", undefined]) expect(eventsOf(await drain(connector(auroraDocMock(account()), { environment }).historicalImport({ cursor: null } as never)))).toHaveLength(6);
  });

  it("counts a token's lifetime on the connector's clock", async () => {
    let clock = NOW().getTime();
    const mock = auroraDocMock(account());
    const c = connector(mock, { now: () => new Date(clock) });
    await drain(c.incrementalSync({ cursor: null } as never));
    clock += 16 * 60_000;
    await drain(c.incrementalSync({ cursor: null } as never));
    expect(mock.signIns).toBe(2);
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = auroraDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.query.dateFrom).toBe("2025-11-11T15:00:00.000Z");
    const ranges: { from: string; to: string }[] = [];
    const fake: AuroraClient = { baseUrl: API, batches: async (r) => (ranges.push(r), { items: [], more: false }), transactions: async () => ({ items: [], more: false }) };
    const before = Date.now();
    const batches = await drain(auroraConnector({ client: fake }).incrementalSync({ cursor: null } as never));
    const after = Date.now();
    expect(Date.parse(ranges[0]!.from)).toBeGreaterThanOrEqual(before - AURORA_OVERLAP_MS);
    expect(Date.parse(ranges[0]!.to)).toBeLessThanOrEqual(after);
    expect(Date.parse(ranges[0]!.to) - Date.parse(ranges[0]!.from)).toBe(AURORA_OVERLAP_MS);
    const next = Date.parse(parseAuroraCursor(batches.at(-1)!.cursor ?? null)!.nextFrom);
    expect(next).toBeGreaterThanOrEqual(before - AURORA_OVERLAP_MS);
    expect(next).toBeLessThanOrEqual(after - AURORA_OVERLAP_MS);
    ranges.length = 0;
    const started = Date.now();
    await drain(auroraConnector({ client: fake }).historicalImport({ cursor: null } as never));
    expect(Date.parse(ranges[0]!.to)).toBeGreaterThanOrEqual(started);
  });

  it("only ever asks for a token and lists batches and transactions", async () => {
    const mock = auroraDocMock(account());
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`))).toEqual(new Set([`POST ${OAUTH}/oauth2/token`, `GET ${API}/pay-api/v1/settlements/batches`, `GET ${API}/pay-api/v1/transactions`]));
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(AURORA_WRITES).toEqual([
      { integration: "aurora_payments", name: "refund_transaction", description: "Refund all or part of a settled Aurora Payments card or ACH transaction", kind: "update", approval: "each", dailyCap: 10 },
      { integration: "aurora_payments", name: "void_transaction", description: "Void an Aurora Payments transaction before its batch settles", kind: "update", approval: "each", dailyCap: 10 },
    ]);
    const c = connector(auroraDocMock(account()));
    expect(c.writes).toBe(AURORA_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "refund_transaction", integration: "aurora_payments", outcome: "refused" },
      { action: "void_transaction", integration: "aurora_payments", outcome: "refused" },
    ]);
  });
});

describe("Aurora Payments doc mock", () => {
  it("checks the key, the token, the dates and the paging", async () => {
    auroraBatch.reset();
    const mock = auroraDocMock({ clientId: ID, clientSecret: SECRET, batches: auroraBatch.many(30, (n) => ({ batchDateTime: ago(30 - n) })), transactions: [] });
    const signIn = (auth: string, body = "grant_type=client_credentials", type = "application/x-www-form-urlencoded") => mock.fetch(`${OAUTH}/oauth2/token`, { method: "POST", headers: { authorization: auth, "content-type": type }, body });
    expect((await signIn(`Basic ${Buffer.from("a:b").toString("base64")}`)).status).toBe(401);
    expect((await signIn(BASIC, "grant_type=password")).status).toBe(400);
    expect((await signIn(BASIC, "grant_type=client_credentials", "application/json")).status).toBe(400);
    const { access_token } = (await (await signIn(BASIC)).json()) as { access_token: string };
    const get = async (q: string, bearer = access_token) => mock.fetch(`${API}/pay-api/v1/settlements/batches?${q}`, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await get("", "nope")).status).toBe(401);
    for (const q of ["page=-1", "pageSize=0", "page=x", "dateFrom=soon"]) expect((await get(q)).status, q).toBe(400);
    const first = (await (await get("")).json()) as { items: AuroraMockRecord[]; total: number };
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(30);
    // Newest first unless asked otherwise.
    expect(first.items[0]!.id).toBe("00000001-0000-4000-8000-000000000030");
    const asc = (await (await get(`asc=true&page=1&pageSize=20&dateTo=${encodeURIComponent(ago(5))}`)).json()) as { items: AuroraMockRecord[]; total: number };
    expect(asc.total).toBe(25);
    expect(asc.items.map((b) => b.id)).toEqual(["00000001-0000-4000-8000-000000000021", "00000001-0000-4000-8000-000000000022", "00000001-0000-4000-8000-000000000023", "00000001-0000-4000-8000-000000000024", "00000001-0000-4000-8000-000000000025"]);
    const all = (await (await mock.fetch(`${API}/pay-api/v1/transactions`, { headers: { authorization: `Bearer ${access_token}` } })).json()) as { items: unknown[] };
    expect(all.items).toEqual([]);
    const forbidden = auroraDocMock({ clientId: ID, clientSecret: SECRET, batches: [], transactions: [], forbidden: ["batches"] });
    const t = (await (await forbidden.fetch(`${OAUTH}/oauth2/token`, { method: "POST", headers: { authorization: BASIC, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json()) as { access_token: string };
    expect((await forbidden.fetch(`${API}/pay-api/v1/settlements/batches`, { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(403);
    expect(mock.fetch.calls.length).toBeGreaterThan(5);
  });
});
