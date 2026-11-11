import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertWritesRefused, checkConnectorSync, rampDocMock, rampTransaction, testPipeline, type RampMock, type RampMockData } from "@karatos/connector-testkit";
import {
  RAMP_API_URLS,
  RAMP_OVERLAP_MS,
  RAMP_PAGE_SIZE,
  RAMP_SCOPE,
  RAMP_TOKEN_PATH,
  RAMP_TRANSACTIONS_PATH,
  RAMP_TRANSACTION_EVENT,
  RAMP_WRITES,
  RampApiError,
  RampConfigError,
  parseRampCursor,
  rampClient,
  rampConnector,
  rampListUrl,
  rampMajorAmount,
  rampMinorAmount,
  rampTime,
  rampTransactionEvent,
  rampTransactionRef,
  rampUserRef,
  type RampClient,
  type RampEvent,
  type RampOptions,
  type RampPage,
} from "../src/index.js";

// Credential-shaped test values, assembled at runtime so no scanner mistakes the source for a leak.
const ID = ["ramp", "id", "0".repeat(16)].join("_");
const SECRET = ["ramp", "sec", "0".repeat(24)].join("_");
const BASIC = `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`;
const NOW = () => new Date("2026-11-11T15:00:00.000Z");
const RECEIVED = "2026-11-11T15:00:00.000Z";
const DAY_MS = 86_400_000;
const API = "https://api.ramp.com";
const LIST = `${API}/developer/v1/transactions`;
const noSleep = async () => {};

/** An ISO time `ago` days before NOW, as Ramp writes it. */
const ago = (days: number) => new Date(NOW().getTime() - days * DAY_MS).toISOString().replace(".000Z", "+00:00");

/** Purchases made 1, 30, 1,000 and 1,820 days ago, and six years ago. */
function account(overrides: Partial<RampMockData> = {}): RampMockData {
  rampTransaction.reset();
  return {
    clientId: ID,
    clientSecret: SECRET,
    transactions: [1, 30, 1000, 1820, 2200].map((d) => rampTransaction.one({ user_transaction_time: ago(d), updated_at: ago(d) })),
    ...overrides,
  };
}

const connector = (mock: RampMock, overrides: Partial<RampOptions> = {}) => rampConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as RampEvent[];

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
const TOKEN = json(200, { access_token: "tok_000000000001", token_type: "Bearer", expires_in: 864_000, scope: "transactions:read" });
const PAGE = (data: unknown[] = [], next: string | null = null) => json(200, { data, page: { next } });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof rampClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = rampClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: async (ms) => void slept.push(ms), now: NOW, ...extra });
  return { c, slept };
};
const F = "2021-11-11T15:00:00.000Z";
const T = "2026-11-11T15:00:00.000Z";
const RANGE = { fromDate: F, toDate: T };

describe("Ramp client", () => {
  it("checks its credentials and environment before sending anything", () => {
    const { fetch, sent } = scripted(TOKEN);
    const make = (o: Record<string, unknown>) => () => rampClient({ clientId: ID, clientSecret: SECRET, fetch, ...o } as never);
    for (const clientId of ["", "a".repeat(7), "a".repeat(201), `${ID}!`, `${ID} x`, undefined]) expect(make({ clientId }), String(clientId)).toThrow("RAMP_CLIENT_ID is missing or not in the expected shape");
    for (const clientSecret of ["", "a".repeat(7), "a".repeat(201), `${SECRET}/`, undefined]) expect(make({ clientSecret }), String(clientSecret)).toThrow("RAMP_CLIENT_SECRET is missing or not in the expected shape");
    expect(make({ clientId: "" })).toThrow(RampConfigError);
    for (const ok of [{ clientId: "a".repeat(8) }, { clientId: "a".repeat(200) }, { clientId: ` ${ID} ` }, { clientSecret: "A-b_9.~zz" }, { clientSecret: "s".repeat(200) }]) expect(make(ok)).not.toThrow();
    for (const environment of ["staging", "toString", "Production"]) expect(make({ environment }), environment).toThrow("RAMP_ENVIRONMENT must be production or sandbox");
    expect(make({ environment: "sandbox" })().baseUrl).toBe("https://demo-api.ramp.com");
    expect(make({})().baseUrl).toBe(API);
    expect(RAMP_API_URLS).toEqual({ production: API, sandbox: "https://demo-api.ramp.com" });
    expect(sent).toHaveLength(0);
  });

  it("asks for transactions:read only with its client credentials, then lists with the token", async () => {
    const row = { id: "t1" };
    const { fetch, sent } = scripted(TOKEN, PAGE([row]));
    const { c } = client(fetch, { clientId: ` ${ID} `, clientSecret: ` ${SECRET} ` });
    expect(await c.transactions(RANGE)).toEqual({ transactions: [row], next: null });
    expect(sent).toEqual([
      {
        url: "https://api.ramp.com/developer/v1/token",
        method: "POST",
        headers: { authorization: BASIC, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: "grant_type=client_credentials&scope=transactions%3Aread",
      },
      {
        url: `${LIST}?page_size=100&from_date=2021-11-11T15%3A00%3A00.000Z&to_date=2026-11-11T15%3A00%3A00.000Z&order_by_date_asc=true`,
        method: "GET",
        headers: { authorization: "Bearer tok_000000000001", accept: "application/json" },
        body: undefined,
      },
    ]);
    expect([RAMP_SCOPE, RAMP_PAGE_SIZE, RAMP_TOKEN_PATH, RAMP_TRANSACTIONS_PATH]).toEqual(["transactions:read", 100, "/developer/v1/token", "/developer/v1/transactions"]);
    expect(await c.transactions({ updatedAfter: F })).toEqual({ transactions: [row], next: null });
    expect(sent[2]!.url).toBe(`${LIST}?page_size=100&updated_after=2021-11-11T15%3A00%3A00.000Z`);
    // The token is kept, so the second list asked for no new one.
    expect(sent).toHaveLength(3);
    expect(await c.transactions({ fromDate: F, toDate: F })).toMatchObject({ next: null });
  });

  it("goes to the sandbox when told", async () => {
    const { fetch, sent } = scripted(TOKEN, PAGE());
    await client(fetch, { environment: "sandbox" }).c.transactions(RANGE);
    expect(sent.map((s) => s.url.split("?")[0])).toEqual(["https://demo-api.ramp.com/developer/v1/token", "https://demo-api.ramp.com/developer/v1/transactions"]);
  });

  it("checks the times before sending", async () => {
    const { fetch, sent } = scripted(TOKEN, PAGE());
    const { c } = client(fetch);
    for (const [f, t] of [["2021-11-11", T], [F, "2026-11-11"], [`x${F}`, T], [`${F}x`, T], [F, `0${T}`], [T, F], ["2021-11-11T15:00:00+00:00", T], ["2021-11-11T15:00:00.0000Z", T]]) {
      await expect(c.transactions({ fromDate: f!, toDate: t! }), `${f} ${t}`).rejects.toThrow("a transaction list must run from one ISO UTC time to a later one");
    }
    for (const u of ["2021-11-11", `${F}x`, `x${F}`, "2021-11-11T15:00:00+01:00"]) await expect(c.transactions({ updatedAfter: u }), u).rejects.toThrow("updated_after must be an ISO UTC time");
    await expect(c.transactions({ updatedAfter: "" })).rejects.toBeInstanceOf(RampApiError);
    expect(await c.transactions({ fromDate: "2021-11-11T15:00:00Z", toDate: "2026-11-11T15:00:00Z" })).toMatchObject({ next: null });
    expect(sent).toHaveLength(2);
  });

  it("follows Ramp's next links only back to the transactions list on the same host", async () => {
    const next = `${LIST}?page_size=100&start=abc`;
    const { fetch, sent } = scripted(TOKEN, PAGE([{ id: "1" }], next), PAGE([{ id: "2" }]));
    const { c } = client(fetch);
    expect(await c.transactions(RANGE)).toEqual({ transactions: [{ id: "1" }], next });
    expect(await c.page(next)).toEqual({ transactions: [{ id: "2" }], next: null });
    expect(sent[2]!.url).toBe(next);
    const bad = [
      "https://evil.test/developer/v1/transactions?start=1",
      "http://api.ramp.com/developer/v1/transactions?start=1",
      "https://demo-api.ramp.com/developer/v1/transactions?start=1",
      "https://api.ramp.com:8443/developer/v1/transactions?start=1",
      "https://api.ramp.com/developer/v1/users?start=1",
      "https://api.ramp.com/developer/v1/transactions/1",
      "https://user:pw@api.ramp.com/developer/v1/transactions",
      "https://user@api.ramp.com/developer/v1/transactions",
      "https://:pw@api.ramp.com/developer/v1/transactions",
      "https://api.ramp.com/developer/v1/transactions#x",
      "/developer/v1/transactions?start=1",
      "not a url",
    ];
    for (const link of bad) {
      await expect(c.page(link), link).rejects.toThrow("a next page link must point at Ramp's transactions list");
      const answered = client(scripted(TOKEN, PAGE([], link)).fetch).c;
      await expect(answered.transactions(RANGE), link).rejects.toThrow("Ramp's next page link doesn't point at the transactions list");
    }
    expect(sent).toHaveLength(3);
    for (const end of [null, undefined, ""]) expect(await client(scripted(TOKEN, json(200, { data: [], page: { next: end } })).fetch).c.transactions(RANGE)).toEqual({ transactions: [], next: null });
    expect(await client(scripted(TOKEN, json(200, { data: [] })).fetch).c.transactions(RANGE)).toEqual({ transactions: [], next: null });
    expect(await client(scripted(TOKEN, json(200, { data: [], page: null })).fetch).c.transactions(RANGE)).toEqual({ transactions: [], next: null });
    for (const link of [5, 0, false, {}]) await expect(client(scripted(TOKEN, json(200, { data: [], page: { next: link } })).fetch).c.transactions(RANGE), String(link)).rejects.toThrow("next page link");
    // A link is kept as a URL writes it.
    expect(await client(scripted(TOKEN, PAGE([], "HTTPS://API.RAMP.COM/developer/v1/transactions?start=a b")).fetch).c.transactions(RANGE)).toEqual({ transactions: [], next: `${LIST}?start=a%20b` });
  });

  it("reads list links", () => {
    expect(rampListUrl(`${LIST}?start=1`, API)?.toString()).toBe(`${LIST}?start=1`);
    expect(rampListUrl(LIST, API)?.toString()).toBe(LIST);
    for (const v of [5, null, undefined, {}, `${LIST}/`, "https://api.ramp.com/developer/v1/transactionsx"]) expect(rampListUrl(v, API), String(v)).toBeNull();
  });

  it("turns down a token granted anything beyond transactions:read", async () => {
    for (const scope of ["transactions:read transactions:write", "transactions:write", "transactions:read users:read", "", "transactions:read transactions:read", undefined, 5]) {
      const { fetch, sent } = scripted(json(200, { access_token: "tok_000000000001", expires_in: 864_000, scope }), PAGE());
      const e = await client(fetch).c.transactions(RANGE).catch((err: Error) => err);
      expect(e, String(scope)).toBeInstanceOf(RampConfigError);
      expect((e as Error).message).toBe("Ramp granted the app scopes other than transactions:read, so its token isn't used");
      expect(sent, String(scope)).toHaveLength(1);
    }
    // Extra spaces between scopes don't matter.
    expect(await client(scripted(json(200, { access_token: "tok_000000000001", expires_in: 864_000, scope: " transactions:read  " }), PAGE()).fetch).c.transactions(RANGE)).toMatchObject({ next: null });
  });

  it("says when Ramp turns down the credentials or the token, never repeating Ramp's words", async () => {
    for (const status of [400, 401, 403]) {
      const e = await client(scripted(json(status, { error: `bad ${SECRET}` })).fetch).c.transactions(RANGE).catch((err: Error) => err);
      expect(e).toBeInstanceOf(RampConfigError);
      expect((e as Error).message).toBe(`Ramp turned down RAMP_CLIENT_ID and RAMP_CLIENT_SECRET (HTTP ${status})`);
    }
    for (const status of [404, 501]) await expect(client(scripted(json(status, {})).fetch).c.transactions(RANGE)).rejects.toMatchObject({ name: "RampApiError", status, message: `Ramp answered HTTP ${status} for a token` });
    for (const body of [{}, { access_token: "" }, { access_token: "short" }, { access_token: "seven77" }, { access_token: "has space in it" }, { access_token: 5 }, null]) {
      await expect(client(scripted(json(200, body)).fetch).c.transactions(RANGE), JSON.stringify(body)).rejects.toThrow("Ramp answered without a token");
    }
    await expect(client(scripted(text(200, "<html>")).fetch).c.transactions(RANGE)).rejects.toThrow("Ramp answered without a token");
    expect(await client(scripted(json(200, { access_token: "a".repeat(4096), scope: RAMP_SCOPE, expires_in: 10 }), PAGE()).fetch).c.transactions(RANGE)).toMatchObject({ next: null });
    await expect(client(scripted(json(200, { access_token: "a".repeat(4097), scope: RAMP_SCOPE })).fetch).c.transactions(RANGE)).rejects.toThrow("without a token");
    const forbidden = await client(scripted(TOKEN, json(403, { error: "missing scope" })).fetch).c.transactions(RANGE).catch((err: Error) => err);
    expect(forbidden).toBeInstanceOf(RampConfigError);
    expect((forbidden as Error).message).toBe("Ramp turned down the app's token for transactions:read (HTTP 403)");
    for (const status of [400, 404, 501]) await expect(client(scripted(TOKEN, json(status, {})).fetch).c.transactions(RANGE)).rejects.toMatchObject({ name: "RampApiError", status, message: `Ramp answered HTTP ${status} for transactions` });
    for (const answer of [json(200, {}), json(200, { data: "a,b" }), json(200, null), json(200, []), text(200, "<html>")]) {
      await expect(client(scripted(TOKEN, answer).fetch).c.transactions(RANGE)).rejects.toThrow("Ramp answered without its transactions");
    }
  });

  it("renews a token Ramp stops taking once, then says so", async () => {
    const renewed = scripted(TOKEN, json(401, {}), TOKEN, PAGE([{ id: "1" }]));
    expect(await client(renewed.fetch).c.transactions(RANGE)).toEqual({ transactions: [{ id: "1" }], next: null });
    expect(renewed.sent.map((s) => s.method)).toEqual(["POST", "GET", "POST", "GET"]);
    const twice = scripted(TOKEN, json(401, {}), TOKEN, json(401, {}), TOKEN, PAGE());
    const e = await client(twice.fetch).c.transactions(RANGE).catch((err: Error) => err);
    expect(e).toBeInstanceOf(RampConfigError);
    expect((e as Error).message).toBe("Ramp turned down the app's token for transactions:read (HTTP 401)");
    expect(twice.sent).toHaveLength(4);
  });

  it("renews a token five minutes before it runs out, and at once when Ramp gives no lifetime", async () => {
    let t = NOW().getTime();
    const now = () => new Date(t);
    const { fetch, sent } = scripted(TOKEN, PAGE(), PAGE(), TOKEN, PAGE());
    const { c } = client(fetch, { now });
    await c.transactions(RANGE);
    t += 864_000_000 - 300_001;
    await c.transactions(RANGE);
    t += 1;
    await c.transactions(RANGE);
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET", "GET", "POST", "GET"]);
    for (const expires_in of [undefined, 0, -5, "864000"]) {
      const none = scripted(json(200, { access_token: "tok_000000000001", scope: RAMP_SCOPE, expires_in }), PAGE(), json(200, { access_token: "tok_000000000002", scope: RAMP_SCOPE }), PAGE());
      const { c: c2 } = client(none.fetch);
      await c2.transactions(RANGE);
      await c2.transactions(RANGE);
      expect(none.sent.map((s) => s.method), String(expires_in)).toEqual(["POST", "GET", "POST", "GET"]);
      expect(none.sent[3]!.headers.authorization).toBe("Bearer tok_000000000002");
    }
  });

  it("waits out rate limits and server errors, honoring Retry-After up to a minute, then gives up", async () => {
    const { fetch, sent } = scripted(json(429, {}, { "retry-after": "5" }), TOKEN, json(500, {}), json(502, {}, { "retry-after": "600" }), json(503, {}), PAGE());
    const { c, slept } = client(fetch, { retries: 4 });
    expect(await c.transactions(RANGE)).toEqual({ transactions: [], next: null });
    // The token's wait and the list's waits are counted apart.
    expect(slept).toEqual([5000, 1000, 60_000, 4000]);
    expect(sent).toHaveLength(6);
    expect(sent.slice(2).every((s) => s.url === sent[2]!.url)).toBe(true);
    const gave = client(scripted(TOKEN, json(504, {})).fetch);
    await expect(gave.c.transactions(RANGE)).rejects.toMatchObject({ status: 504 });
    expect(gave.slept).toEqual([1000, 2000, 4000]);
    const zero = client(scripted(json(429, {}, { "retry-after": "0" }), TOKEN, PAGE()).fetch);
    await zero.c.transactions(RANGE);
    expect(zero.slept).toEqual([1000]);
  });

  it("doesn't retry other errors, and retries as many times as told", async () => {
    const once = scripted(TOKEN, json(400, {}));
    await expect(client(once.fetch).c.transactions(RANGE)).rejects.toMatchObject({ status: 400 });
    expect(once.sent).toHaveLength(2);
    const none = scripted(json(500, {}), TOKEN);
    await expect(client(none.fetch, { retries: 0 }).c.transactions(RANGE)).rejects.toMatchObject({ status: 500, message: "Ramp answered HTTP 500 for a token" });
    expect(none.sent).toHaveLength(1);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(json(503, {}, { "retry-after": "0.001" }), TOKEN, PAGE(), PAGE());
    globalThis.fetch = fetch;
    try {
      const c = rampClient({ clientId: ID, clientSecret: SECRET });
      expect(await c.transactions(RANGE)).toEqual({ transactions: [], next: null });
      await c.transactions(RANGE);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST", "GET", "GET"]);
  });
});

describe("Ramp reading helpers", () => {
  it("reads Ramp's times as UTC", () => {
    expect(rampTime("2022-04-28T00:00:00+00:00")).toBe("2022-04-28T00:00:00.000Z");
    expect(rampTime("2022-04-28T09:30:00-04:00")).toBe("2022-04-28T13:30:00.000Z");
    expect(rampTime("2022-04-28T09:30:00.123456Z")).toBe("2022-04-28T09:30:00.123Z");
    expect(rampTime("2022-05-03T00:00:00")).toBe("2022-05-03T00:00:00.000Z");
    // Even on a host whose clock is elsewhere.
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(rampTime("2022-05-03T00:00:00")).toBe("2022-05-03T00:00:00.000Z");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
    expect(rampTime("2024-02-29T23:59:59Z")).toBe("2024-02-29T23:59:59.000Z");
    for (const v of ["", "2022-04-28", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:00:60Z", "2026-01-01 10:00:00Z", "x2026-01-01T10:00:00Z", "2026-01-01T10:00:00Zx", "2026-01-01T10:00:00.1234567Z", "2026-01-01T10:00:00+0100", 1_700_000_000, null]) {
      expect(rampTime(v), String(v)).toBeUndefined();
    }
  });

  it("reads amount objects in minor units", () => {
    expect(rampMinorAmount({ value: 24_000, currency: "USD", minor_unit_conversion_rate: 100 })).toEqual({ cents: 24_000, currency: "USD" });
    expect(rampMinorAmount({ amount: -9000, currency_code: "EUR" })).toEqual({ cents: -9000, currency: "EUR" });
    expect(rampMinorAmount({ value: 500, currency: "JPY", minor_unit_conversion_rate: 1 })).toEqual({ cents: 50_000, currency: "JPY" });
    expect(rampMinorAmount({ value: 1234, currency: "KWD", minor_unit_conversion_rate: 1000 })).toEqual({ cents: 123, currency: "KWD" });
    expect(rampMinorAmount({ value: 1235, currency: "KWD", minor_unit_conversion_rate: 1000 })).toEqual({ cents: 124, currency: "KWD" });
    expect(rampMinorAmount({ value: 15, currency: "XYZ", minor_unit_conversion_rate: 10 })).toEqual({ cents: 150, currency: "XYZ" });
    // value comes before amount, and currency before currency_code.
    expect(rampMinorAmount({ value: 1, amount: 2, currency: "USD", currency_code: "EUR" })).toEqual({ cents: 1, currency: "USD" });
    for (const v of [
      null,
      [],
      "100",
      { value: 1.5, currency: "USD" },
      { value: "100", currency: "USD" },
      { value: 2 ** 53, currency: "USD" },
      { value: 100, currency: "usd" },
      { value: 100, currency: "USDX" },
      { value: 100 },
      { currency: "USD" },
      { value: 100, currency: "USD", minor_unit_conversion_rate: 0 },
      { value: 100, currency: "USD", minor_unit_conversion_rate: 50 },
      { value: 100, currency: "USD", minor_unit_conversion_rate: "100" },
      { value: 100, currency: "USD", minor_unit_conversion_rate: null },
    ]) {
      expect(rampMinorAmount(v), JSON.stringify(v)).toBeUndefined();
    }
  });

  it("reads amounts in whole units as cents", () => {
    for (const [v, c] of [[240, 24_000], [0.29, 29], [19.99, 1999], [-35.1, -3510], [0.005, 1], [-0.005, -1], [0, 0], [9_999_999_999.99, 999_999_999_999]] as const) expect(rampMajorAmount(v, "USD"), String(v)).toEqual({ cents: c, currency: "USD" });
    for (const v of [1e10, -1e10, Number.NaN, Number.POSITIVE_INFINITY, "240", null]) expect(rampMajorAmount(v, "USD"), String(v)).toBeUndefined();
    for (const c of ["usd", "US", "USDD", 5, undefined]) expect(rampMajorAmount(240, c), String(c)).toBeUndefined();
  });

  it("makes references", () => {
    expect(rampTransactionRef("a")).toBe("ramp:transaction:a");
    expect(rampUserRef("b")).toBe("ramp:user:b");
  });
});

describe("Ramp events", () => {
  const ctx = { receivedAt: RECEIVED };
  const read = (overrides: Record<string, unknown> = {}) => {
    rampTransaction.reset();
    return rampTransactionEvent(rampTransaction.one(overrides), ctx);
  };

  it("keeps what finance uses, and no names, memo text or receipt files", () => {
    const e = read();
    expect(e).toEqual({
      id: e.idempotencyKey.replace(/:/g, "_"),
      type: RAMP_TRANSACTION_EVENT,
      occurredAt: "2026-01-01T01:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^ramp:transaction:00000001-0000-4000-8000-000000000001:[0-9a-f]{12}$/),
      payload: {
        system: "Ramp",
        transactionId: "ramp:transaction:00000001-0000-4000-8000-000000000001",
        amountCents: 24_000,
        currency: "USD",
        direction: "out",
        originalAmountCents: null,
        originalCurrency: null,
        state: "cleared",
        merchantName: "Test Shipping Supplies",
        merchantCategoryCode: "4215",
        spendCategory: "Shipping",
        glAccount: "Postage and Delivery",
        cardholderRef: "ramp:user:00000004-0000-4000-8000-000000000001",
        department: "Operations",
        location: "Main Store",
        hasReceipt: true,
        hasMemo: true,
        policyViolations: 0,
        disputed: false,
        readyToClose: true,
        refundOf: null,
        transactedAt: "2026-01-01T01:00:00.000Z",
        settledAt: "2026-01-01T01:00:00.000Z",
      },
    });
    expect(RAMP_TRANSACTION_EVENT).toBe("card.transaction_updated");
    const shown = JSON.stringify(e);
    for (const hidden of ["Cardholder", "Overnight", "TEST SHIPPING", "00000009-", "00000003-", "00000002-", "6100"]) expect(shown, hidden).not.toContain(hidden);
  });

  it("reads a refund and a charge in another currency", () => {
    const refund = read({ entity_amount: { value: -5000, currency: "USD", minor_unit_conversion_rate: 100 }, original_transaction_id: "00000001-0000-4000-8000-000000000099" });
    expect(refund.payload).toMatchObject({ amountCents: 5000, direction: "in", refundOf: "ramp:transaction:00000001-0000-4000-8000-000000000099" });
    const abroad = read({ merchant_amount: { value: 22_000, currency: "EUR", minor_unit_conversion_rate: 100 } });
    expect(abroad.payload).toMatchObject({ amountCents: 24_000, currency: "USD", originalAmountCents: 22_000, originalCurrency: "EUR" });
    const old = read({ merchant_amount: undefined, original_transaction_amount: { amount: -900_000, currency_code: "JPY" } });
    expect(old.payload).toMatchObject({ originalAmountCents: 900_000, originalCurrency: "JPY" });
    const unread = read({ merchant_amount: { value: "x" }, original_transaction_amount: null });
    expect(unread.payload).toMatchObject({ originalAmountCents: null, originalCurrency: null });
  });

  it("falls back to the whole-unit amount when entity_amount doesn't read", () => {
    for (const entity_amount of [undefined, null, { value: 1.5, currency: "USD" }]) {
      expect(read({ entity_amount, amount: -12.34, currency_code: "CAD" }).payload, JSON.stringify(entity_amount)).toMatchObject({ amountCents: 1234, currency: "CAD", direction: "in" });
    }
    expect(read({ entity_amount: undefined, amount: 0 }).payload).toMatchObject({ amountCents: 0, direction: "out" });
  });

  it("reads Ramp's states, and an unknown one as unknown", () => {
    for (const s of ["CLEARED", "COMPLETION", "PENDING", "PENDING_INITIATION", "DECLINED", "ERROR"]) expect(read({ state: s }).payload.state).toBe(s.toLowerCase());
    for (const s of ["cleared", "SETTLED", "", 5, undefined, "toString"]) expect(read({ state: s }).payload.state, String(s)).toBe("unknown");
  });

  it("keeps the optional fields only when they read", () => {
    const bare = read({
      merchant_name: "  ",
      merchant_category_code: "42150",
      sk_category_name: 5,
      accounting_field_selections: "GL",
      card_holder: null,
      receipts: [],
      memo: "   ",
      policy_violations: [{ id: "p" }, { id: "q" }],
      disputes: [{ id: "d" }],
      all_requirements_met_and_approved: "yes",
      original_transaction_id: "not an id!",
      settlement_date: null,
    });
    expect(bare.payload).toMatchObject({
      merchantName: null,
      merchantCategoryCode: null,
      spendCategory: null,
      glAccount: null,
      cardholderRef: null,
      department: null,
      location: null,
      hasReceipt: false,
      hasMemo: false,
      policyViolations: 2,
      disputed: true,
      readyToClose: null,
      refundOf: null,
      settledAt: null,
    });
    const missing = read({ receipts: "r", memo: 5, policy_violations: "p", disputes: "d", merchant_category_code: 4215, all_requirements_met_and_approved: false, card_holder: { user_id: "has space", department_name: " Sales ", location_name: "x".repeat(300) } });
    expect(missing.payload).toMatchObject({ hasReceipt: false, hasMemo: false, policyViolations: 0, disputed: false, merchantCategoryCode: null, readyToClose: false, cardholderRef: null, department: "Sales", location: "x".repeat(200) });
    expect(read({ merchant_name: " Gem Supply " }).payload.merchantName).toBe("Gem Supply");
    // A holder without a user ID or location name is never named some other way.
    expect(read({ card_holder: { user_id: null, first_name: "Test", last_name: "Holder", location_id: "00000006-0000-4000-8000-000000000001" } }).payload).toMatchObject({ cardholderRef: null, location: null });
  });

  it("finds the GL account among the selections", () => {
    const gl = (accounting_field_selections: unknown) => read({ accounting_field_selections }).payload.glAccount;
    expect(gl([{ type: "SUBSIDIARY", name: "Main" }, { type: "GL_ACCOUNT", name: "Supplies" }, { type: "GL_ACCOUNT", name: "Second" }])).toBe("Supplies");
    expect(gl([{ name: "From category", category_info: { type: "GL_ACCOUNT" } }])).toBe("From category");
    expect(gl([{ type: "SUBSIDIARY", name: "Main", category_info: { type: "GL_ACCOUNT" } }])).toBeNull();
    expect(gl([null, "x", { type: "GL_ACCOUNT" }, { type: "GL_ACCOUNT", name: "Later" }])).toBeNull();
    expect(gl([])).toBeNull();
  });

  it("keys each version by what was kept, so an unchanged one is a duplicate", () => {
    const a = read();
    expect(read().idempotencyKey).toBe(a.idempotencyKey);
    expect(read({ receipts: [] }).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(read({ state: "PENDING" }).idempotencyKey).not.toBe(a.idempotencyKey);
    // What isn't kept doesn't make a new version.
    expect(read({ memo: "Another memo", synced_at: "2026-01-02T00:00:00+00:00" }).idempotencyKey).toBe(a.idempotencyKey);
  });

  it("dead-letters a transaction that doesn't read, listing why", () => {
    const e = rampTransactionEvent({ id: "bad id", user_transaction_time: "yesterday", amount: "12" }, ctx);
    expect(e).toMatchObject({
      type: RAMP_TRANSACTION_EVENT,
      occurredAt: undefined,
      idempotencyKey: expect.stringMatching(/^ramp:unreadable_transaction:[0-9a-f]{12}$/),
      payload: { system: "Ramp", transactionId: null, problems: ["transaction has no ID that reads", "transaction has no time that reads", "transaction has no amount that reads"] },
    });
    expect(e.id).toBe(e.idempotencyKey.replace(/:/g, "_"));
    for (const raw of [null, "x", [1]]) expect(rampTransactionEvent(raw, ctx).payload.problems).toHaveLength(3);
    const one = read({ user_transaction_time: null });
    expect(one.payload).toEqual({ system: "Ramp", transactionId: "00000001-0000-4000-8000-000000000001", problems: ["transaction has no time that reads"] });
    expect(read({ entity_amount: null, amount: null }).payload.problems).toEqual(["transaction has no amount that reads"]);
    expect(read({ id: "a".repeat(65) }).payload.problems).toEqual(["transaction has no ID that reads"]);
    expect(read({ id: "a".repeat(64) }).payload.problems).toBeUndefined();
  });
});

describe("Ramp checkpoint", () => {
  it("reads a checkpoint it wrote, and turns down anything else", () => {
    const at = "2026-11-10T15:00:00.000Z";
    expect(parseRampCursor(null, API)).toBeNull();
    expect(parseRampCursor(JSON.stringify({ next: null, done: true, nextFrom: at }), API)).toEqual({ next: null, done: true, nextFrom: at });
    expect(parseRampCursor(JSON.stringify({ next: `${LIST}?start=1`, done: false, nextFrom: at }), API)).toEqual({ next: `${LIST}?start=1`, done: false, nextFrom: at });
    for (const raw of [
      "",
      "{",
      "null",
      "[]",
      "5",
      JSON.stringify({ next: null, done: "true", nextFrom: at }),
      JSON.stringify({ next: null, nextFrom: at }),
      JSON.stringify({ next: null, done: true }),
      JSON.stringify({ next: null, done: true, nextFrom: "2026-11-10" }),
      JSON.stringify({ next: null, done: true, nextFrom: "2026-11-10T15:00:00Z" }),
      JSON.stringify({ next: null, done: true, nextFrom: "2026-02-30T15:00:00.000Z" }),
      JSON.stringify({ next: null, done: true, nextFrom: `x${at}` }),
      JSON.stringify({ next: null, done: true, nextFrom: `${at}x` }),
      JSON.stringify({ done: true, nextFrom: at }),
      JSON.stringify({ next: "https://evil.test/developer/v1/transactions", done: false, nextFrom: at }),
      JSON.stringify({ next: 5, done: false, nextFrom: at }),
    ]) {
      expect(() => parseRampCursor(raw, API), raw).toThrow("Ramp checkpoint is not in the expected shape");
    }
    // A sandbox link isn't a production checkpoint.
    expect(() => parseRampCursor(JSON.stringify({ next: `${LIST}?start=1`, done: false, nextFrom: at }), "https://demo-api.ramp.com")).toThrow("Ramp checkpoint");
  });
});

describe("Ramp connector", () => {
  it("passes the shared connector checks", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(rampDocMock(account())), expected: { ingested: 4 } });
    expect(result.full.ingested).toBe(4);
  });

  it("imports five years oldest first, then stops for good", async () => {
    const mock = rampDocMock(account());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4);
    expect(mock.reads).toEqual([{ page_size: "100", from_date: "2021-11-11T15:00:00.000Z", to_date: "2026-11-11T15:00:00.000Z", order_by_date_asc: "true" }]);
    expect(mock.tokens).toEqual([{ grant_type: "client_credentials", scope: "transactions:read" }]);
    expect(parseRampCursor(report.cursor, API)).toEqual({ next: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" });
    const again = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(again.ingested + again.duplicates).toBe(0);
    expect(mock.reads).toHaveLength(1);
  });

  it("pages with Ramp's links, keeping each in the checkpoint, and resumes there", async () => {
    rampTransaction.reset();
    const rows = rampTransaction.many(RAMP_PAGE_SIZE * 2 + 5, (n) => ({ user_transaction_time: ago(10 - n / 1000), updated_at: ago(1) }));
    const data: RampMockData = { clientId: ID, clientSecret: SECRET, transactions: rows };
    const batches = await drain(connector(rampDocMock(data)).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 5]);
    const cursors = batches.map((b) => parseRampCursor(b.cursor ?? null, API)!);
    expect(cursors.map((c) => [c.next === null, c.done])).toEqual([[false, false], [false, false], [true, true]]);
    expect(cursors[0]!.next).toContain("start=");
    const resumed = rampDocMock(data);
    // Resumed a day later, the pass keeps where the next later sync starts.
    const rest = await drain(connector(resumed, { now: () => new Date(NOW().getTime() + DAY_MS) }).historicalImport({ cursor: batches[0]!.cursor ?? null } as never));
    expect(eventsOf(rest)).toHaveLength(105);
    expect(parseRampCursor(rest.at(-1)!.cursor ?? null, API)).toEqual({ next: null, done: true, nextFrom: cursors[0]!.nextFrom });
    expect(resumed.reads).toHaveLength(2);
    expect(resumed.reads[0]!.start).toBe(new URL(cursors[0]!.next!).searchParams.get("start"));
    expect(new Set(eventsOf([...batches, ...rest]).map((e) => e.idempotencyKey)).size).toBe(205);
    // A resumed later sync goes on from its link too, keeping what it knew of the import.
    const mid = JSON.stringify({ next: cursors[0]!.next, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const later = await drain(connector(rampDocMock(data)).incrementalSync({ cursor: mid } as never));
    expect(eventsOf(later)).toHaveLength(105);
    expect(parseRampCursor(later[0]!.cursor ?? null, API)).toMatchObject({ done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    expect(parseRampCursor(later.at(-1)!.cursor ?? null, API)).toEqual({ next: null, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    const midImport = JSON.stringify({ next: cursors[1]!.next, done: false, nextFrom: "2026-11-01T00:00:00.000Z" });
    const ended = await drain(connector(rampDocMock(data)).incrementalSync({ cursor: midImport } as never));
    expect(parseRampCursor(ended.at(-1)!.cursor ?? null, API)!.done).toBe(false);
  });

  it("lists what changed after a day before the last pass on each later sync", async () => {
    const data = account();
    const mock = rampDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    // Each mode keeps its own checkpoint, so the first later sync looks back a day.
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)).toEqual({ page_size: "100", updated_after: "2026-11-10T15:00:00.000Z" });
    expect(first.ingested).toBe(0);
    expect(first.duplicates).toBe(0);
    expect(parseRampCursor(first.cursor, API)).toEqual({ next: null, done: false, nextFrom: "2026-11-10T15:00:00.000Z" });
    expect(RAMP_OVERLAP_MS).toBe(DAY_MS);
    // A receipt goes missing on a month-old purchase, which Ramp marks as changed.
    data.transactions[1]!.receipts = [];
    data.transactions[1]!.updated_at = ago(-1);
    const later = () => new Date(NOW().getTime() + 2 * DAY_MS);
    const sync = await runSync({ connector: connector(mock, { now: later }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(mock.reads.at(-1)).toEqual({ page_size: "100", updated_after: "2026-11-10T15:00:00.000Z" });
    expect(sync.ingested).toBe(1);
    expect(parseRampCursor(sync.cursor, API)).toEqual({ next: null, done: false, nextFrom: "2026-11-12T15:00:00.000Z" });
    const hidden = data.transactions.map((t) => ({ ...t, updated_at: ago(-0.5) }));
    const doneCursor = JSON.stringify({ next: null, done: true, nextFrom: "2026-11-11T00:00:00.000Z" });
    const again = await drain(connector(rampDocMock({ ...data, transactions: hidden })).incrementalSync({ cursor: doneCursor } as never));
    expect(eventsOf(again)).toHaveLength(5);
    expect(parseRampCursor(again.at(-1)!.cursor ?? null, API)).toEqual({ next: null, done: true, nextFrom: "2026-11-10T15:00:00.000Z" });
  });

  it("dead-letters a transaction that doesn't read and keeps going", async () => {
    const data = account();
    data.transactions[0]!.entity_amount = null;
    data.transactions[0]!.amount = "lots";
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(rampDocMock(data)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3);
    expect(report.deadLettered).toBe(1);
  });

  it("waits out a rate limit inside a sync", async () => {
    const mock = rampDocMock(account({ rateLimits: 2 }));
    const slept: number[] = [];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms) }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(4);
    expect(slept).toEqual([1000, 1000]);
  });

  it("turns down a token with a write scope inside a sync, reading nothing", async () => {
    const mock = rampDocMock(account({ grantScope: "transactions:read transactions:write" }));
    await expect(drain(connector(mock).historicalImport({ cursor: null } as never))).rejects.toThrow("Ramp granted the app scopes other than transactions:read");
    expect(mock.reads).toHaveLength(0);
    const wrong = rampDocMock(account({ clientSecret: "another_secret_000" }));
    await expect(drain(connector(wrong).historicalImport({ cursor: null } as never))).rejects.toThrow("Ramp turned down RAMP_CLIENT_ID and RAMP_CLIENT_SECRET (HTTP 401)");
    const unscoped = rampDocMock(account({ grantScope: "users:read" }));
    const c = rampClient({ clientId: ID, clientSecret: SECRET, fetch: unscoped.fetch, sleep: noSleep });
    await expect(c.transactions(RANGE)).rejects.toBeInstanceOf(RampConfigError);
  });

  it("follows a next link even from an empty page, and doesn't import again once done", async () => {
    const link = `${LIST}?start=1`;
    const seen: string[] = [];
    const fake: RampClient = {
      baseUrl: API,
      transactions: async () => ({ transactions: [], next: link }),
      page: async (next) => (seen.push(next), { transactions: [{}], next: null }),
    };
    const batches = await drain(rampConnector({ clientId: ID, clientSecret: SECRET, client: fake, now: NOW }).historicalImport({ cursor: null } as never));
    expect(batches.map((b) => b.events.length)).toEqual([0, 1]);
    expect(seen).toEqual([link]);
    const finished = JSON.stringify({ next: link, done: true, nextFrom: "2026-11-01T00:00:00.000Z" });
    expect(await drain(rampConnector({ clientId: ID, clientSecret: SECRET, client: fake }).historicalImport({ cursor: finished } as never))).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("checks its options", async () => {
    const mock = rampDocMock(account());
    for (const historyYears of [0, -1, 1.5]) expect(() => connector(mock, { historyYears }), String(historyYears)).toThrow("historyYears must be a positive whole number");
    for (const environment of ["staging", "PRODUCTION"]) expect(() => connector(mock, { environment: environment as never }), environment).toThrow("RAMP_ENVIRONMENT must be production or sandbox");
    expect(() => connector(mock, { environment: " " as never })).not.toThrow();
    expect(() => connector(mock, { clientId: "x" })).toThrow("RAMP_CLIENT_ID");
    expect(() => connector(mock, { clientId: "x", client: {} as RampClient })).not.toThrow();
    expect(connector(mock).source).toBe("ramp");
    const sandbox = rampDocMock(account({ baseUrl: "https://demo-api.ramp.com" }));
    const report = await drain(connector(sandbox, { environment: " sandbox " as never }).historicalImport({ cursor: null } as never));
    expect(eventsOf(report)).toHaveLength(4);
  });

  it("reads back as far as told, and up to now when no clock is given", async () => {
    const mock = rampDocMock(account());
    await drain(connector(mock, { historyYears: 1 }).historicalImport({ cursor: null } as never));
    expect(mock.reads[0]!.from_date).toBe("2025-11-11T15:00:00.000Z");
    const queries: unknown[] = [];
    const fake: RampClient = { baseUrl: API, transactions: async (q) => (queries.push(q), { transactions: [], next: null }) as RampPage, page: async () => ({ transactions: [], next: null }) };
    const before = Date.now();
    await drain(rampConnector({ clientId: ID, clientSecret: SECRET, client: fake }).incrementalSync({ cursor: null } as never));
    await drain(rampConnector({ clientId: ID, clientSecret: SECRET, client: fake }).historicalImport({ cursor: null } as never));
    const after = Date.now();
    const u = Date.parse((queries[0] as { updatedAfter: string }).updatedAfter);
    expect(u).toBeGreaterThanOrEqual(before - DAY_MS);
    expect(u).toBeLessThanOrEqual(after - DAY_MS);
    const to = Date.parse((queries[1] as { toDate: string }).toDate);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);
  });

  it("only ever asks for a token and lists transactions", async () => {
    rampTransaction.reset();
    const data: RampMockData = { clientId: ID, clientSecret: SECRET, transactions: rampTransaction.many(250, (n) => ({ user_transaction_time: ago(n), updated_at: ago(0.1) })) };
    const mock = rampDocMock(data);
    await drain(connector(mock).historicalImport({ cursor: null } as never));
    await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`))).toEqual(new Set(["POST https://api.ramp.com/developer/v1/token", "GET https://api.ramp.com/developer/v1/transactions"]));
    expect(new Set(mock.tokens.map((t) => t.scope))).toEqual(new Set(["transactions:read"]));
  });

  it("declares its writes and turns them down while writes are off", async () => {
    expect(RAMP_WRITES.map((w) => w.name)).toEqual(["set_transaction_memo", "set_transaction_category"]);
    const c = connector(rampDocMock(account()));
    expect(c.writes).toBe(RAMP_WRITES);
    expect(await assertWritesRefused(c)).toMatchObject([
      { action: "set_transaction_memo", integration: "ramp", outcome: "refused" },
      { action: "set_transaction_category", integration: "ramp", outcome: "refused" },
    ]);
  });
});

describe("Ramp doc mock", () => {
  it("checks the credentials, the scope, the filters and the page size", async () => {
    const mock = rampDocMock(account());
    const token = (auth: string, body: string, type = "application/x-www-form-urlencoded") => mock.fetch(`${API}/developer/v1/token`, { method: "POST", headers: { authorization: auth, "content-type": type }, body });
    expect((await token("Basic eA==", "grant_type=client_credentials")).status).toBe(401);
    expect((await token(BASIC, "grant_type=client_credentials", "application/json")).status).toBe(400);
    expect((await token(BASIC, "grant_type=password")).status).toBe(400);
    const none = (await (await token(BASIC, "grant_type=client_credentials")).json()) as Record<string, unknown>;
    expect(none).toMatchObject({ token_type: "Bearer", expires_in: 864_000, scope: "" });
    const list = (auth: string, query = "") => mock.fetch(`${LIST}${query}`, { headers: { authorization: auth } });
    expect((await list("")).status).toBe(401);
    expect((await list("Bearer nope")).status).toBe(401);
    expect((await list(`Bearer ${String(none.access_token)}`)).status).toBe(403);
    const scoped = (await (await token(BASIC, "grant_type=client_credentials&scope=transactions%3Aread")).json()) as Record<string, unknown>;
    const bearer = `Bearer ${String(scoped.access_token)}`;
    for (const q of ["?page_size=1", "?page_size=101", "?page_size=x", "?from_date=2026-01-01", "?updated_after=yesterday", "?start=nope"]) expect((await list(bearer, q)).status, q).toBe(400);
    const first = (await (await list(bearer, "?page_size=2")).json()) as { data: Record<string, unknown>[]; page: { next: string | null } };
    expect(first.data).toHaveLength(2);
    expect(first.page.next).toContain("start=");
    const all = (await (await list(bearer)).json()) as { data: unknown[]; page: { next: string | null } };
    expect(all).toMatchObject({ page: { next: null } });
    expect(all.data).toHaveLength(5);
    const ranged = (await (await list(bearer, `?from_date=${encodeURIComponent(ago(31))}&to_date=${encodeURIComponent(ago(1))}`)).json()) as { data: unknown[] };
    expect(ranged.data).toHaveLength(2);
  });
});
