import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { STWM_DOC_PAGES, STWM_MOCK_BASE, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, stwmDocMock, stwmModel, testPipeline, type StwmMock, type StwmMockData } from "@karatos/connector-testkit";
import { STWM_BASE, STWM_CURRENCIES, STWM_MAX_REFERENCES, STWM_PRICE_EVENT, STWM_RESERVE, STWM_SPACING_MS, STWM_WEEK_EVENT, STWM_WRITES, StwmApiError, StwmConfigError, parseStwmCursor, parseStwmReferences, stwmClient, stwmConnector, stwmPriceEvents, stwmText, stwmUnmatched, stwmWeekEvents, type StwmClient, type StwmCursor, type StwmEvent, type StwmModel, type StwmOptions } from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const API_KEY = ["test", "k".repeat(24)].join(".");
const NOW = () => new Date("2026-11-11T15:30:00.000Z");
const RECEIVED = "2026-11-11T15:30:00.000Z";
const DAY = "2026-11-11";
const noSleep = async () => {};
const ctx = { receivedAt: RECEIVED, day: DAY };

/** Two models, the second answered by two of the references. */
function store(overrides: Partial<StwmMockData> = {}): StwmMockData {
  return {
    apiKey: API_KEY,
    models: [stwmModel(1), stwmModel(2, 30_000)],
    ...overrides,
  };
}
const REFS = "TEST-1, Test Diver 2,\nTEST-2";
const connector = (mock: StwmMock, overrides: Partial<StwmOptions> = {}) =>
  stwmConnector({
    apiKey: API_KEY,
    references: REFS,
    fetch: mock.fetch,
    sleep: noSleep,
    now: NOW,
    ...overrides,
  });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as StwmEvent[];

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
    sent.push({
      url,
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return answers[Math.min(sent.length - 1, answers.length - 1)]!();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}
const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers });
const text = (status: number, body: string) => () => new Response(body, { status });
const OK = json(200, { status: 1, group_id: 7 });
const client = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof stwmClient>[0]> = {}) => {
  const slept: number[] = [];
  const c = stwmClient({
    apiKey: API_KEY,
    fetch,
    sleep: async (ms) => void slept.push(ms),
    clock: () => 1e9,
    ...extra,
  });
  return { c, slept };
};
const MODEL: StwmModel = {
  groupId: 7,
  brand: "Testmaker",
  modelNumber: "TEST-7",
  name: "Testmaker Test Diver 7",
};

describe("Search The Watch Market client", () => {
  it("checks its key before sending anything", () => {
    const { fetch, sent } = scripted(OK);
    for (const apiKey of ["", "a".repeat(15), "a".repeat(201), `${"a".repeat(16)} x`, `${"a".repeat(16)}/`]) expect(() => stwmClient({ apiKey, fetch }), apiKey).toThrow("STWM_API_KEY is missing or not in the expected shape");
    expect(() => stwmClient({} as never)).toThrow(StwmConfigError);
    expect(() => stwmClient({ apiKey: ` ${"aZ9_.-".repeat(33)}aa `, fetch })).not.toThrow();
    expect(sent).toHaveLength(0);
    expect(STWM_BASE).toBe(STWM_MOCK_BASE);
  });

  it("sends GETs with the key as a Bearer token, and reads what each answers", async () => {
    const resolved = json(200, {
      status: 1,
      group_id: 7,
      brand: " Testmaker ",
      model_number: "TEST-7",
      display_name: "<b>x</b>",
    });
    const { fetch, sent } = scripted(resolved, OK, OK, OK);
    const { c } = client(fetch, { apiKey: ` ${API_KEY} ` });
    expect(await c.resolve(" 5711/1A & co ")).toEqual({
      groupId: 7,
      brand: "Testmaker",
      modelNumber: "TEST-7",
      name: undefined,
    });
    expect(await c.prices(7)).toEqual({ status: 1, group_id: 7 });
    expect(await c.daysToSell(7)).toEqual({ status: 1, group_id: 7 });
    expect(await c.history(7)).toEqual({ status: 1, group_id: 7 });
    const headers = {
      authorization: `Bearer ${API_KEY}`,
      accept: "application/json",
    };
    expect(sent).toEqual([
      {
        url: `${STWM_BASE}/data/resolve?q=5711%2F1A+%26+co`,
        method: "GET",
        headers,
      },
      { url: `${STWM_BASE}/data/model/7/prices`, method: "GET", headers },
      { url: `${STWM_BASE}/data/model/7/days-to-sell`, method: "GET", headers },
      { url: `${STWM_BASE}/data/model/7/history`, method: "GET", headers },
    ]);
  });

  it("answers null for a 404, and won't ask about a reference or model that doesn't read", async () => {
    const { fetch, sent } = scripted(json(404, { status: 0, error: "not_found" }));
    const { c } = client(fetch);
    expect(await c.resolve("TEST-9")).toBeNull();
    expect(await c.prices(7)).toBeNull();
    for (const q of ["", " ", "a<b", "x".repeat(121), "a\u0007"])
      await expect(c.resolve(q), q).rejects.toMatchObject({
        message: "a reference must be plain text up to 120 characters",
        status: 0,
      });
    for (const id of [0, -1, 1.5, Number.NaN])
      await expect(c.history(id), String(id)).rejects.toMatchObject({
        message: "a model group must be a whole number above zero",
        status: 0,
      });
    expect(sent).toHaveLength(2);
    expect(await client(scripted(OK).fetch).c.resolve("x".repeat(120))).toMatchObject({ groupId: 7 });
  });

  it("turns down a resolve without a model group", async () => {
    for (const group_id of [undefined, 0, -3, 2.5, "7"]) {
      await expect(client(scripted(json(200, { status: 1, group_id })).fetch).c.resolve("TEST-1"), String(group_id)).rejects.toMatchObject({
        message: "Search The Watch Market resolved a reference without a model group",
        status: 200,
      });
    }
    expect(await client(scripted(json(200, { status: 1, group_id: 1 })).fetch).c.resolve("TEST-1")).toEqual({
      groupId: 1,
      brand: undefined,
      modelNumber: undefined,
      name: undefined,
    });
  });

  it("explains a key that's turned down and a used-up allowance, and reports other errors", async () => {
    await expect(client(scripted(json(401, { status: 0, error: "unauthorized" })).fetch).c.prices(7)).rejects.toThrow(new StwmConfigError("Search The Watch Market turned down STWM_API_KEY: check it and that the subscription is active"));
    const { fetch, sent } = scripted(json(429, {}));
    await expect(client(fetch).c.prices(7)).rejects.toMatchObject({
      message: "Search The Watch Market's daily allowance is used up; the sync goes on after midnight UTC",
      status: 429,
    });
    expect(sent).toHaveLength(1);
    for (const status of [206, 400, 403, 502]) {
      const error = await client(scripted(json(status, {})).fetch)
        .c.daysToSell(7)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StwmApiError);
      expect(error).toMatchObject({
        message: `Search The Watch Market answered HTTP ${status} for the days to sell of a model`,
        status,
      });
    }
    for (const body of [null, [], "x", 5, {}, { status: 0 }, { status: "1" }]) {
      await expect(client(scripted(json(200, body)).fetch).c.history(7), JSON.stringify(body)).rejects.toMatchObject({
        message: "Search The Watch Market answered the history of a model with something other than a success",
        status: 200,
      });
    }
    await expect(client(scripted(text(200, "<html>")).fetch).c.resolve("x")).rejects.toThrow("Search The Watch Market answered a reference with something other than a success");
  });

  it("waits out a 500 or 503 5, 10 and 20 seconds, then gives up, and retries as many times as told", async () => {
    for (const status of [500, 503]) {
      const { fetch, sent } = scripted(json(status, {}));
      const { c, slept } = client(fetch, {
        clock: () => 1e12 + 1e6 * sent.length,
      });
      await expect(c.prices(7)).rejects.toMatchObject({ status });
      expect(sent, String(status)).toHaveLength(4);
      expect(slept).toEqual([5000, 10_000, 20_000]);
    }
    const { fetch, sent } = scripted(json(503, {}), OK);
    expect(await client(fetch, { clock: () => 1e12 + 1e6 * sent.length }).c.prices(7)).toEqual({ status: 1, group_id: 7 });
    const { fetch: f0, sent: s0 } = scripted(json(500, {}));
    await expect(client(f0, { retries: 0 }).c.prices(7)).rejects.toMatchObject({
      status: 500,
    });
    expect(s0).toHaveLength(1);
  });

  it("keeps the allowance left from each answer that says it", async () => {
    const left = (v: string) => json(200, { status: 1, group_id: 7 }, { "x-ratelimit-remaining": v });
    const { fetch } = scripted(OK, left("998"), left("x"), left("1".repeat(10)), left("0"), json(404, {}, { "x-ratelimit-remaining": "3" }));
    const { c } = client(fetch);
    expect(c.remaining()).toBeNull();
    await c.prices(7);
    expect(c.remaining()).toBeNull();
    await c.prices(7);
    expect(c.remaining()).toBe(998);
    await c.prices(7);
    await c.prices(7);
    expect(c.remaining()).toBe(998);
    await c.prices(7);
    expect(c.remaining()).toBe(0);
    await c.prices(7);
    expect(c.remaining()).toBe(3);
    expect(client(scripted(OK).fetch).c.remaining()).toBeNull();
  });

  it("spaces its calls a quarter second apart", async () => {
    let t = 1e9;
    const { fetch } = scripted(OK);
    const { c, slept } = client(fetch, { clock: () => t });
    await c.prices(7);
    expect(slept).toEqual([]);
    await c.prices(7);
    expect(slept).toEqual([STWM_SPACING_MS]);
    t += STWM_SPACING_MS - 1;
    await c.prices(7);
    expect(slept).toEqual([STWM_SPACING_MS, 1]);
    t += STWM_SPACING_MS;
    await c.prices(7);
    expect(slept).toEqual([STWM_SPACING_MS, 1]);
    expect(STWM_SPACING_MS).toBe(250);
  });

  it("waits for real, and uses the global fetch and clock, when none is given", async () => {
    const real = globalThis.fetch;
    const { fetch, sent } = scripted(OK);
    globalThis.fetch = fetch;
    const started = Date.now();
    try {
      const c = stwmClient({ apiKey: API_KEY });
      await c.prices(7);
      await c.prices(7);
    } finally {
      globalThis.fetch = real;
    }
    expect(sent).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(STWM_SPACING_MS - 20);
  });

  it("only ever sends GETs of the four reads", async () => {
    const mock = stwmDocMock(store());
    const { memory, pipeline } = testPipeline();
    await runSync({
      connector: connector(mock),
      mode: "historical",
      pipeline,
      memory,
      organizationId: TEST_ORG,
    });
    expect(new Set(mock.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace(/\d+/, "N")}`))).toEqual(new Set(["GET /data/resolve", "GET /data/model/N/prices", "GET /data/model/N/days-to-sell", "GET /data/model/N/history"]));
  });

  it("keeps text plain, trimmed and short", () => {
    expect(stwmText(" Testmaker ")).toBe("Testmaker");
    expect(stwmText("x".repeat(120))).toBe("x".repeat(120));
    for (const v of ["", "  ", "x".repeat(121), "a>b", "a<b", "a\nb", 5, null, undefined]) expect(stwmText(v), String(v)).toBeUndefined();
  });
});

describe("Search The Watch Market events", () => {
  const prices = (extra: Record<string, unknown> = {}) => ({
    status: 1,
    group_id: 7,
    currency: "USD",
    listing_count: 40,
    min: 9600,
    max: 18_000,
    mean: 12_000,
    market_value: 11_400,
    ...extra,
  });
  const days = (extra: Record<string, unknown> = {}) => ({
    status: 1,
    group_id: 7,
    sell_within_50_days: 21,
    sell_within_95_days: 90,
    ...extra,
  });
  const week = (date: string, usd = 12_000, extra: Record<string, unknown> = {}) => ({
    week: date,
    count: 30,
    mean: { USD: usd, EUR: 10_800 },
    min: { USD: 9600, EUR: 8640 },
    max: { USD: 18_000, EUR: 16_200 },
    ...extra,
  });
  const model = {
    system: "Search The Watch Market",
    groupId: "stwm:model:7",
    reference: "TEST-7",
    brand: "Testmaker",
    modelNumber: "TEST-7",
    name: "Testmaker Test Diver 7",
  };

  it("makes the day's observation from the prices and days to sell", () => {
    const [e] = stwmPriceEvents(prices(), days(), "TEST-7", MODEL, ctx);
    expect(e).toMatchObject({
      type: STWM_PRICE_EVENT,
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
    });
    expect(e!.payload).toEqual({
      ...model,
      observedOn: DAY,
      currency: "USD",
      listings: 40,
      low: 9600,
      high: 18_000,
      mean: 12_000,
      marketValue: 11_400,
      sellWithin50Days: 21,
      sellWithin95Days: 90,
    });
    expect(e!.idempotencyKey).toMatch(/^stwm:price:7:2026-11-11:[0-9a-f]{12}$/);
    expect(e!.id).toBe(e!.idempotencyKey.replace(/:/g, "_"));
    expect(STWM_PRICE_EVENT).toBe("watch_market.price_observed");
  });

  it("keeps an observation without days to sell, or with one of them, and none without prices", () => {
    expect(stwmPriceEvents(prices(), null, "TEST-7", MODEL, ctx)[0]!.payload).toMatchObject({
      sellWithin50Days: undefined,
      sellWithin95Days: undefined,
    });
    expect(stwmPriceEvents(prices(), days({ sell_within_95_days: undefined }), "TEST-7", MODEL, ctx)[0]!.payload).toMatchObject({ sellWithin50Days: 21, sellWithin95Days: undefined });
    expect(stwmPriceEvents(prices(), days({ sell_within_50_days: 0 }), "TEST-7", MODEL, ctx)[0]!.payload).toMatchObject({ sellWithin50Days: 0 });
    expect(stwmPriceEvents(prices({ min: 0, listing_count: 0 }), null, "TEST-7", MODEL, ctx)[0]!.payload).toMatchObject({ low: 0, listings: 0 });
    expect(stwmPriceEvents(null, days(), "TEST-7", MODEL, ctx)).toEqual([]);
  });

  it("is a duplicate read again the same day unchanged, and a new event on a change or a new day", () => {
    const a = stwmPriceEvents(prices(), days(), "TEST-7", MODEL, ctx)[0]!;
    expect(
      stwmPriceEvents(prices(), days(), "TEST-7", MODEL, {
        receivedAt: "2026-11-11T20:00:00.000Z",
        day: DAY,
      })[0]!.idempotencyKey,
    ).toBe(a.idempotencyKey);
    expect(stwmPriceEvents(prices({ mean: 12_001 }), days(), "TEST-7", MODEL, ctx)[0]!.idempotencyKey).not.toBe(a.idempotencyKey);
    expect(
      stwmPriceEvents(prices(), days(), "TEST-7", MODEL, {
        ...ctx,
        day: "2026-11-12",
      })[0]!.idempotencyKey,
    ).toMatch(/^stwm:price:7:2026-11-12:/);
  });

  it("dead-letters prices or days to sell that don't read, listing each problem", () => {
    const dead = (p: unknown, d: unknown) => {
      const events = stwmPriceEvents(p, d, "TEST-7", MODEL, ctx);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: STWM_PRICE_EVENT,
        occurredAt: undefined,
        receivedAt: RECEIVED,
      });
      expect(events[0]!.idempotencyKey).toMatch(/^stwm:unreadable:[0-9a-f]{12}$/);
      expect(events[0]!.id).toBe(events[0]!.idempotencyKey.replace(/:/g, "_"));
      return events[0]!.payload;
    };
    expect(dead(prices({ group_id: 8 }), days())).toEqual({
      system: "Search The Watch Market",
      problems: ["the prices are not for the model asked about"],
    });
    for (const currency of [undefined, "XYZ", "usd", 5]) expect(dead(prices({ currency }), days()).problems, String(currency)).toEqual(["the prices have no known currency"]);
    for (const field of ["listing_count", "min", "max", "mean", "market_value"]) {
      for (const v of [undefined, -1, 1.5, "100"]) expect(dead(prices({ [field]: v }), days()).problems, `${field} ${v}`).toEqual([`the prices have no whole ${field}`]);
    }
    expect(dead(prices(), days({ group_id: 8 })).problems).toEqual(["the days to sell are not for the model asked about"]);
    for (const field of ["sell_within_50_days", "sell_within_95_days"]) {
      for (const v of [null, -1, 2.5, "3"]) expect(dead(prices(), days({ [field]: v })).problems, `${field} ${v}`).toEqual([`the days to sell have a ${field} that isn't a whole number`]);
    }
    expect(dead([], [])).toEqual({
      system: "Search The Watch Market",
      problems: ["the prices are not for the model asked about", "the prices have no known currency", "the prices have no whole listing_count", "the prices have no whole min", "the prices have no whole max", "the prices have no whole mean", "the prices have no whole market_value", "the days to sell are not for the model asked about"],
    });
    expect(dead("x", null).problems).toHaveLength(7);
    expect(stwmPriceEvents(prices({ group_id: 8 }), days(), "TEST-7", MODEL, ctx)[0]!.idempotencyKey).not.toBe(stwmPriceEvents(prices({ group_id: 9 }), days(), "TEST-7", MODEL, ctx)[0]!.idempotencyKey);
    for (const currency of STWM_CURRENCIES) expect(stwmPriceEvents(prices({ currency }), null, "TEST-7", MODEL, ctx)[0]!.occurredAt).toBe(RECEIVED);
  });

  it("makes one event for each week, dated at its first day, with each currency's prices in a fixed order", () => {
    const events = stwmWeekEvents(
      {
        status: 1,
        group_id: 7,
        weeks: [week("2026-10-26"), week("2026-11-02", 12_500)],
      },
      "TEST-7",
      MODEL,
      ctx,
    );
    expect(events.map((e) => [e.type, e.occurredAt, e.receivedAt])).toEqual([
      [STWM_WEEK_EVENT, "2026-10-26T00:00:00.000Z", RECEIVED],
      [STWM_WEEK_EVENT, "2026-11-02T00:00:00.000Z", RECEIVED],
    ]);
    expect(events[0]!.payload).toEqual({
      ...model,
      week: "2026-10-26",
      listings: 30,
      prices: [
        { currency: "EUR", low: 8640, high: 16_200, mean: 10_800 },
        { currency: "USD", low: 9600, high: 18_000, mean: 12_000 },
      ],
    });
    expect(events[0]!.idempotencyKey).toMatch(/^stwm:week:7:2026-10-26:[0-9a-f]{12}$/);
    expect(events[0]!.id).toBe(events[0]!.idempotencyKey.replace(/:/g, "_"));
    expect(STWM_WEEK_EVENT).toBe("watch_market.price_week");
    const again = stwmWeekEvents({ status: 1, group_id: 7, weeks: [week("2026-10-26")] }, "TEST-7", MODEL, { ...ctx, day: "2026-11-12" });
    expect(again[0]!.idempotencyKey).toBe(events[0]!.idempotencyKey);
  });

  it("leaves out currencies it doesn't know, keeps a week with no prices, and takes only the history's own keys", () => {
    const w = {
      week: "2026-10-26",
      count: 0,
      mean: { USD: 1, JPY: 150, XYZ: 5, __proto__: { CHF: 9 } },
      min: { USD: 1, JPY: 100 },
      max: { USD: 1, JPY: 200, toString: 3 },
    };
    const [e] = stwmWeekEvents({ group_id: 7, weeks: [w] }, "TEST-7", MODEL, ctx);
    expect(e!.payload.prices).toEqual([
      { currency: "JPY", low: 100, high: 200, mean: 150 },
      { currency: "USD", low: 1, high: 1, mean: 1 },
    ]);
    expect(e!.occurredAt).toBe("2026-10-26T00:00:00.000Z");
    expect(stwmWeekEvents({ group_id: 7, weeks: [{ ...w, max: { USD: 1 } }] }, "TEST-7", MODEL, ctx)[0]!.payload.problems).toEqual(["a week has a price that isn't a whole number"]);
    const [plain] = stwmWeekEvents({ group_id: 7, weeks: [{ week: "2026-10-26", count: 3 }] }, "TEST-7", MODEL, ctx);
    expect(plain!.payload).toMatchObject({ listings: 3, prices: [] });
  });

  it("dead-letters a history for another model or without weeks, and each week that doesn't read", () => {
    for (const h of [{ group_id: 8, weeks: [] }, { group_id: 7 }, { group_id: 7, weeks: {} }, [], "x"]) {
      const events = stwmWeekEvents(h, "TEST-7", MODEL, ctx);
      expect(events, JSON.stringify(h)).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: STWM_WEEK_EVENT,
        occurredAt: undefined,
        payload: {
          system: "Search The Watch Market",
          problems: ["the history is not a list of weeks for the model asked about"],
        },
      });
    }
    expect(stwmWeekEvents(null, "TEST-7", MODEL, ctx)).toEqual([]);
    expect(stwmWeekEvents({ group_id: 7, weeks: [] }, "TEST-7", MODEL, ctx)).toEqual([]);
    const bad: [unknown, string[]][] = [
      [week("2026-02-30"), ["a week has no date"]],
      [week("2026-1-5"), ["a week has no date"]],
      [week("x"), ["a week has no date"]],
      [{ ...week("2026-10-26"), week: 5 }, ["a week has no date"]],
      [{ ...week("2026-10-26"), count: -1 }, ["a week has no whole count"]],
      [{ ...week("2026-10-26"), count: 1.5 }, ["a week has no whole count"]],
      [week("2026-10-26", -1), ["a week has a price that isn't a whole number"]],
      [{ ...week("2026-10-26"), min: { USD: 2.5 } }, ["a week has a price that isn't a whole number"]],
      [{ ...week("2026-10-26"), max: { USD: "9" } }, ["a week has a price that isn't a whole number"]],
      [null, ["a week has no date", "a week has no whole count"]],
      ["x", ["a week has no date", "a week has no whole count"]],
    ];
    const events = stwmWeekEvents({ group_id: 7, weeks: [...bad.map((b) => b[0]), week("2026-10-26")] }, "TEST-7", MODEL, ctx);
    expect(events.slice(0, -1).map((e) => e.payload.problems)).toEqual(bad.map((b) => b[1]));
    expect(events.slice(0, -1).every((e) => e.occurredAt === undefined && /^stwm:unreadable:[0-9a-f]{12}$/.test(e.idempotencyKey))).toBe(true);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(events.length);
    expect(events.at(-1)!.occurredAt).toBe("2026-10-26T00:00:00.000Z");
  });

  it("dead-letters a reference that matches no model, once a day", () => {
    const e = stwmUnmatched("TEST-9", ctx);
    expect(e).toMatchObject({
      type: STWM_PRICE_EVENT,
      occurredAt: undefined,
      receivedAt: RECEIVED,
      payload: {
        system: "Search The Watch Market",
        problems: ["the reference TEST-9 matches no model"],
      },
    });
    expect(
      stwmUnmatched("TEST-9", {
        ...ctx,
        receivedAt: "2026-11-11T20:00:00.000Z",
      }).idempotencyKey,
    ).toBe(e.idempotencyKey);
    expect(stwmUnmatched("TEST-9", { ...ctx, day: "2026-11-12" }).idempotencyKey).not.toBe(e.idempotencyKey);
    expect(stwmUnmatched("TEST-8", ctx).idempotencyKey).not.toBe(e.idempotencyKey);
  });
});

describe("Search The Watch Market references and checkpoint", () => {
  it("reads the references, without repeats, in order", () => {
    expect(parseStwmReferences(" TEST-1 ,\n\ntest-1, Test Diver 2,TEST-1 ,  ")).toEqual(["TEST-1", "Test Diver 2"]);
    expect(parseStwmReferences(Array.from({ length: STWM_MAX_REFERENCES }, (_, i) => `R${i}`).join(","))).toHaveLength(STWM_MAX_REFERENCES);
    expect(() => parseStwmReferences(Array.from({ length: STWM_MAX_REFERENCES + 1 }, (_, i) => `R${i}`).join(","))).toThrow(`STWM_REFERENCES lists more than ${STWM_MAX_REFERENCES} references`);
    for (const raw of ["", " , \n "]) expect(() => parseStwmReferences(raw)).toThrow("STWM_REFERENCES lists no reference");
    for (const raw of ["a,<b>", `a,${"x".repeat(121)}`, "a\tb"]) expect(() => parseStwmReferences(raw)).toThrow("STWM_REFERENCES has a reference that isn't plain text up to 120 characters");
    expect(STWM_MAX_REFERENCES).toBe(200);
  });

  const good: StwmCursor = {
    done: false,
    models: [
      [
        "TEST-1",
        {
          groupId: 1001,
          brand: "Testmaker",
          modelNumber: "TEST-1",
          name: "Test",
        },
      ],
      ["TEST-2", { groupId: 1002 } as StwmModel],
    ],
    pass: { references: ["TEST-1", "TEST-2"], day: DAY, next: 1 },
  };

  it("round-trips and turns down any other shape", () => {
    expect(parseStwmCursor(null)).toBeNull();
    expect(parseStwmCursor(JSON.stringify(good))).toEqual(good);
    expect(parseStwmCursor(JSON.stringify({ done: true, models: [], pass: null }))).toEqual({ done: true, models: [], pass: null });
    const p = good.pass!;
    const m = good.models[0]!;
    const bad: unknown[] = [
      "nope",
      "null",
      { ...good, done: 1 },
      { ...good, models: undefined },
      { ...good, models: {} },
      { ...good, models: [m[0]] },
      { ...good, models: [[m[0], m[1], 1]] },
      { ...good, models: [[5, m[1]]] },
      { ...good, models: [[" TEST-1", m[1]]] },
      { ...good, models: [[m[0], null]] },
      { ...good, models: [[m[0], { groupId: 0 }]] },
      { ...good, models: [[m[0], { groupId: 1.5 }]] },
      { ...good, models: [[m[0], { groupId: 1, brand: 5 }]] },
      { ...good, models: [[m[0], { groupId: 1, modelNumber: " x" }]] },
      { ...good, models: [[m[0], { groupId: 1, name: "<b>" }]] },
      { ...good, models: Array(STWM_MAX_REFERENCES + 1).fill(m) },
      { ...good, pass: undefined },
      { ...good, pass: { ...p, references: "TEST-1" } },
      { ...good, pass: { ...p, references: [] } },
      { ...good, pass: { ...p, references: ["TEST-1", 5] } },
      { ...good, pass: { ...p, references: ["TEST-1", " x"] } },
      {
        ...good,
        pass: { ...p, references: Array(STWM_MAX_REFERENCES + 1).fill("x") },
      },
      { ...good, pass: { ...p, day: 5 } },
      { ...good, pass: { ...p, day: "2026-11-1" } },
      { ...good, pass: { ...p, day: "x2026-11-11" } },
      { ...good, pass: { ...p, day: "2026-11-11x" } },
      { ...good, pass: { ...p, next: 0 } },
      { ...good, pass: { ...p, next: 2 } },
      { ...good, pass: { ...p, next: 1.5 } },
      { ...good, pass: { ...p, next: "1" } },
    ];
    for (const raw of bad) expect(() => parseStwmCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw).slice(0, 120)).toThrow("Search The Watch Market checkpoint is not in the expected shape");
    expect(
      parseStwmCursor(
        JSON.stringify({
          ...good,
          models: Array(STWM_MAX_REFERENCES).fill(m),
          pass: {
            ...p,
            references: Array(STWM_MAX_REFERENCES).fill("x"),
            next: STWM_MAX_REFERENCES - 1,
          },
        }),
      )!.models,
    ).toHaveLength(STWM_MAX_REFERENCES);
  });
});

describe("Search The Watch Market connector", () => {
  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({
      makeConnector: () => connector(stwmDocMock(store())),
      expected: { ingested: 28 },
    });
    expect(result.resume!.ingested).toBe(14);
  });

  it("reads each model's prices, days to sell and history once, and resolves each reference once", async () => {
    const mock = stwmDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({
      connector: connector(mock),
      mode: "historical",
      pipeline,
      memory,
      organizationId: TEST_ORG,
    });
    expect(report).toMatchObject({ ingested: 28, deadLettered: 0, batches: 3 });
    expect(mock.fetch.calls.map((c) => c.url.slice(STWM_BASE.length))).toEqual(["/data/resolve?q=TEST-1", "/data/model/1001/prices", "/data/model/1001/days-to-sell", "/data/model/1001/history", "/data/resolve?q=Test+Diver+2", "/data/model/1002/prices", "/data/model/1002/days-to-sell", "/data/model/1002/history", "/data/resolve?q=TEST-2"]);
    const prices = memory.events.filter((e) => e.type === STWM_PRICE_EVENT);
    expect(prices.map((e) => [e.payload.reference, e.payload.groupId, e.payload.mean, e.payload.sellWithin50Days])).toEqual([
      ["TEST-1", "stwm:model:1001", 12_000, 21],
      ["Test Diver 2", "stwm:model:1002", 30_000, 21],
    ]);
    expect(memory.events.filter((e) => e.type === STWM_WEEK_EVENT)).toHaveLength(26);
    assertSynthetic(memory.events);
    const cursor = parseStwmCursor(report.cursor)!;
    expect(cursor).toEqual({
      done: true,
      models: [
        ["TEST-1", expect.objectContaining({ groupId: 1001 })],
        ["Test Diver 2", expect.objectContaining({ groupId: 1002 })],
        ["TEST-2", expect.objectContaining({ groupId: 1002 })],
      ],
      pass: null,
    });
    const calls = mock.fetch.calls.length;
    expect(
      (
        await runSync({
          connector: connector(mock),
          mode: "historical",
          pipeline,
          memory,
          organizationId: TEST_ORG,
        })
      ).ingested,
    ).toBe(0);
    expect(mock.fetch.calls).toHaveLength(calls);
    // A later sync the same day keeps its own checkpoint, so it resolves again, and finds only duplicates.
    const later = await runSync({
      connector: connector(mock),
      mode: "incremental",
      pipeline,
      memory,
      organizationId: TEST_ORG,
    });
    expect(later).toMatchObject({ ingested: 0, duplicates: 28 });
    expect(mock.fetch.calls).toHaveLength(2 * calls);
    // The one after that has the models in its checkpoint, so it doesn't.
    await runSync({
      connector: connector(mock),
      mode: "incremental",
      pipeline,
      memory,
      organizationId: TEST_ORG,
    });
    expect(
      mock.fetch.calls
        .slice(2 * calls)
        .map((c) => c.url.slice(STWM_BASE.length))
        .filter((u) => u.startsWith("/data/resolve")),
    ).toEqual([]);
    expect(mock.fetch.calls).toHaveLength(2 * calls + 6);
  });

  it("keeps the import's state and the pass's day through a later sync, and resumes there", async () => {
    const mock = stwmDocMock(store());
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    const cursors = batches.map((b) => parseStwmCursor(b.cursor as string)!);
    expect(cursors.map((c) => [c.done, c.pass])).toEqual([
      [false, { references: ["TEST-1", "Test Diver 2", "TEST-2"], day: DAY, next: 1 }],
      [false, { references: ["TEST-1", "Test Diver 2", "TEST-2"], day: DAY, next: 2 }],
      [false, null],
    ]);
    const done = {
      ...cursors[0]!,
      done: true,
      pass: { ...cursors[0]!.pass!, day: "2026-11-10" },
    };
    const rest = await drain(
      connector(mock).incrementalSync({
        cursor: JSON.stringify(done),
      } as never),
    );
    expect(
      eventsOf(rest)
        .filter((e) => e.type === STWM_PRICE_EVENT)
        .map((e) => [e.payload.reference, e.payload.observedOn]),
    ).toEqual([["Test Diver 2", "2026-11-10"]]);
    expect(rest.map((b) => parseStwmCursor(b.cursor as string)!.done)).toEqual([true, true]);
    // A model already read earlier in the pass isn't read again on resume.
    const fromLast = { ...cursors[1]!, pass: { ...cursors[1]!.pass! } };
    expect(
      eventsOf(
        await drain(
          connector(mock).incrementalSync({
            cursor: JSON.stringify(fromLast),
          } as never),
        ),
      ),
    ).toEqual([]);
  });

  it("starts a new pass when the references changed, and forgets models no longer followed", async () => {
    const mock = stwmDocMock(store());
    const [first] = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    const before = mock.fetch.calls.length;
    const batches = await drain(
      connector(mock, { references: "TEST-2" }).incrementalSync({
        cursor: first!.cursor,
      } as never),
    );
    expect(batches).toHaveLength(1);
    expect(mock.fetch.calls.slice(before).map((c) => c.url.slice(STWM_BASE.length))).toEqual(["/data/resolve?q=TEST-2", "/data/model/1002/prices", "/data/model/1002/days-to-sell", "/data/model/1002/history"]);
    expect(parseStwmCursor(batches[0]!.cursor as string)!.models.map(([r]) => r)).toEqual(["TEST-2"]);
  });

  it("dead-letters a reference that matches no model, and tries it again next pass", async () => {
    const mock = stwmDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({
      connector: connector(mock, { references: "TEST-9, TEST-1" }),
      mode: "incremental",
      pipeline,
      memory,
      organizationId: TEST_ORG,
    });
    expect(report).toMatchObject({ ingested: 14, deadLettered: 1 });
    expect(parseStwmCursor(report.cursor)!.models.map(([r]) => r)).toEqual(["TEST-1"]);
    await runSync({
      connector: connector(mock, { references: "TEST-9, TEST-1" }),
      mode: "incremental",
      pipeline,
      memory,
      organizationId: TEST_ORG,
    });
    expect(mock.fetch.calls.filter((c) => c.url.includes("q=TEST-9"))).toHaveLength(2);
  });

  it("stops a pass when the day's allowance runs low, and goes on from there next time", async () => {
    // Each read leaves `limit - used`; the pass stops before a reference once fewer than the reserve and four calls are left.
    const mock = stwmDocMock(store({ limit: STWM_RESERVE + 7 }));
    const batches = await drain(connector(mock).incrementalSync({ cursor: null } as never));
    expect(batches).toHaveLength(1);
    expect(mock.remaining).toBe(STWM_RESERVE + 3);
    const rest = await drain(
      connector(stwmDocMock(store())).incrementalSync({
        cursor: batches[0]!.cursor,
      } as never),
    );
    expect(rest).toHaveLength(2);
    const exact = stwmDocMock(store({ limit: STWM_RESERVE + 8 }));
    expect(await drain(connector(exact).incrementalSync({ cursor: null } as never))).toHaveLength(2);
    const fake = (left: number | null): StwmClient => ({
      resolve: async () => null,
      prices: async () => null,
      daysToSell: async () => null,
      history: async () => null,
      remaining: () => left,
    });
    expect(
      await drain(
        connector(mock, { client: fake(STWM_RESERVE + 3) }).incrementalSync({
          cursor: null,
        } as never),
      ),
    ).toEqual([]);
    expect(
      await drain(
        connector(mock, { client: fake(STWM_RESERVE + 4) }).incrementalSync({
          cursor: null,
        } as never),
      ),
    ).toHaveLength(3);
    expect(
      await drain(
        connector(mock, { client: fake(null) }).incrementalSync({
          cursor: null,
        } as never),
      ),
    ).toHaveLength(3);
    expect(STWM_RESERVE).toBe(25);
  });

  it("stops on a used-up allowance or a key that's turned down, keeping its place", async () => {
    const mock = stwmDocMock(store({ limit: 5 }));
    // Without the allowance header, the pass reads on until the API turns it down.
    const quiet = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = await mock.fetch(input, init);
      return new Response(await r.text(), { status: r.status });
    }) as typeof globalThis.fetch;
    const { memory, pipeline } = testPipeline();
    await expect(
      runSync({
        connector: connector(mock, { fetch: quiet }),
        mode: "incremental",
        pipeline,
        memory,
        organizationId: TEST_ORG,
        attempts: 1,
      }),
    ).rejects.toThrow("daily allowance is used up");
    expect(parseStwmCursor(await memory.getCheckpoint(TEST_ORG, "search_the_watch_market", "incremental"))!.pass!.next).toBe(1);
    await expect(drain(connector(stwmDocMock(store({ apiKey: "z".repeat(20) }))).historicalImport({ cursor: null } as never))).rejects.toThrow("turned down STWM_API_KEY");
  });

  it("checks its settings, and dates the pass today when no clock is given", async () => {
    const mock = stwmDocMock(store());
    expect(() => connector(mock, { apiKey: "nope" })).toThrow(StwmConfigError);
    expect(() => connector(mock, { references: "" })).toThrow("STWM_REFERENCES lists no reference");
    const fake: StwmClient = {
      resolve: async () => MODEL,
      prices: async () => ({
        group_id: 7,
        currency: "USD",
        listing_count: 1,
        min: 1,
        max: 1,
        mean: 1,
        market_value: 1,
      }),
      daysToSell: async () => null,
      history: async () => null,
      remaining: () => null,
    };
    expect(() => connector(mock, { apiKey: "nope", client: fake })).not.toThrow();
    const [batch] = await drain(
      stwmConnector({
        apiKey: API_KEY,
        references: "TEST-7",
        client: fake,
      }).incrementalSync({ cursor: null } as never),
    );
    expect((batch!.events[0] as StwmEvent).payload.observedOn).toBe(new Date().toISOString().slice(0, 10));
  });

  it("declares no writes, so none can run", async () => {
    expect(STWM_WRITES).toEqual([]);
    const c = connector(stwmDocMock(store()));
    expect(c.writes).toBe(STWM_WRITES);
    expect(c.source).toBe("search_the_watch_market");
    expect(await assertWritesRefused(c)).toEqual([]);
  });
});

describe("Search The Watch Market doc mock", () => {
  const get = (mock: StwmMock, path: string, key = API_KEY) =>
    mock.fetch(`${STWM_MOCK_BASE}${path}`, {
      headers: { authorization: `Bearer ${key}` },
    });

  it("wants the key, resolves names ignoring case, and answers 404 for what it doesn't know", async () => {
    const mock = stwmDocMock(
      store({
        models: [stwmModel(1), { ...stwmModel(3), days: null, weeks: 2 }, { ...stwmModel(4), days: [undefined, 60] }],
      }),
    );
    expect((await get(mock, "/data/resolve?q=TEST-1", "nope")).status).toBe(401);
    expect(await (await get(mock, "/data/resolve?q=%20test%20diver%201%20")).json()).toEqual({
      status: 1,
      group_id: 1001,
      brand: "Testmaker",
      model_number: "TEST-1",
      display_name: "Testmaker Test Diver 1",
    });
    expect((await get(mock, "/data/resolve?q=")).status).toBe(400);
    expect(await (await get(mock, "/data/resolve?q=TEST-9")).json()).toEqual({
      status: 0,
      error: "not_found",
      message: "No matching group found",
    });
    for (const part of ["prices", "days-to-sell", "history"]) expect((await get(mock, `/data/model/9/${part}`)).status, part).toBe(404);
    expect((await get(mock, "/data/model/1003/days-to-sell")).status).toBe(404);
    expect(await (await get(mock, "/data/model/1004/days-to-sell")).json()).toEqual({ status: 1, group_id: 1004, sell_within_95_days: 60 });
    expect(await (await get(mock, "/data/model/1001/prices")).json()).toEqual({
      status: 1,
      group_id: 1001,
      currency: "USD",
      listing_count: 40,
      min: 9600,
      max: 18_000,
      mean: 12_000,
      market_value: 11_400,
    });
    const history = (await (await get(mock, "/data/model/1003/history")).json()) as { weeks: { week: string; mean: { USD: number } }[] };
    expect(history.weeks.map((w) => [w.week, w.mean.USD])).toEqual([
      ["2026-10-26", 11_950],
      ["2026-11-02", 12_000],
    ]);
    const { days: _, ...noDays } = stwmModel(5);
    const plain = stwmDocMock({ apiKey: API_KEY, models: [noDays] });
    expect(await (await get(plain, "/data/model/1005/days-to-sell")).json()).toMatchObject({ sell_within_50_days: 30, sell_within_95_days: 120 });
    expect(
      (
        (await (await get(plain, "/data/model/1005/history")).json()) as {
          weeks: unknown[];
        }
      ).weeks,
    ).toHaveLength(13);
    expect((await get(stwmDocMock({ apiKey: API_KEY }), "/data/resolve?q=TEST-1")).status).toBe(404);
  });

  it("counts the day's allowance in each answer, and answers 429 past it", async () => {
    const mock = stwmDocMock(store({ limit: 2 }));
    const first = await get(mock, "/data/model/1001/prices");
    expect([first.headers.get("x-ratelimit-limit"), first.headers.get("x-ratelimit-remaining")]).toEqual(["2", "1"]);
    expect((await get(mock, "/data/model/1001/prices", "nope")).status).toBe(401);
    expect(mock.remaining).toBe(1);
    await get(mock, "/data/model/1001/prices");
    expect(await (await get(mock, "/data/model/1001/prices")).json()).toEqual({
      status: 0,
      error: "rate_limited",
      message: "Daily request limit reached",
    });
    expect(mock.remaining).toBe(0);
    expect(stwmDocMock({ apiKey: API_KEY }).remaining).toBe(1000);
    expect(STWM_DOC_PAGES.reference).toMatch(/^https:\/\/github\.com\/searchthewatchmarket\//);
  });
});
