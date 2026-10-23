import { describe, expect, it } from "vitest";
import { combineDepartments, RETAIL_DEPARTMENTS } from "@karatos/retail";
import { TEST_ORG, checkConnectorSync } from "@karatos/connector-testkit";
import {
  MetalsApiConfigError,
  MetalsApiError,
  centsPerOunce,
  historyRequests,
  metalsApiClient,
  metalsApiConnector,
  parseMetalsApiCursor,
  type MetalPriceEvent,
  type MetalsApiCursor,
  type MetalsApiOptions,
} from "../src/index.js";
import type { SourceBatch } from "@karatos/core";

const NOW = () => new Date("2026-10-20T15:00:00Z");
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
// Assembled at runtime so no key-shaped string sits in the repository.
const KEY = ["test", "0".repeat(28)].join("");

/** Synthetic prices in dollars per ounce, the same every day, so tests can check the inversion. */
const PRICE = { XAU: 2500, XAG: 30, XPT: 1000, XPD: 1250 } as const;

interface Sent {
  path: string;
  query: Record<string, string>;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A stand-in for Metals-API built from its documentation: the latest
 * endpoint answers `rates` with both `XAU` (ounces per dollar) and `USDXAU`
 * (dollars per ounce); the timeseries endpoint answers one metal a day
 * keyed by date, inverse rates only.
 */
function fakeApi(overrides: { latest?: () => Response; timeseries?: (q: Record<string, string>) => Response } = {}) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams);
    sent.push({ path: url.pathname, query, method: init?.method ?? "GET", body: init?.body, headers: Object.fromEntries(new Headers(init?.headers)) });
    if (url.pathname === "/api/latest") {
      if (overrides.latest) return overrides.latest();
      const rates: Record<string, number> = { USD: 1 };
      for (const s of query.symbols!.split(",")) {
        rates[s] = 1 / PRICE[s as keyof typeof PRICE];
        rates[`USD${s}`] = PRICE[s as keyof typeof PRICE];
      }
      return Response.json({ success: true, timestamp: 1_792_500_000, date: "2026-10-20", base: "USD", rates });
    }
    if (url.pathname === "/api/timeseries") {
      if (overrides.timeseries) return overrides.timeseries(query);
      const rates: Record<string, Record<string, number>> = {};
      for (let d = Date.parse(`${query.start_date}T00:00:00Z`); d <= Date.parse(`${query.end_date}T00:00:00Z`); d += 86_400_000) {
        rates[new Date(d).toISOString().slice(0, 10)] = { USD: 1, [query.symbols!]: 1 / PRICE[query.symbols as keyof typeof PRICE] };
      }
      return Response.json({ success: true, timeseries: true, start_date: query.start_date, end_date: query.end_date, base: "USD", rates });
    }
    return Response.json({ success: false, error: { code: 404, info: "not found" } }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const connector = (fetch: typeof globalThis.fetch, extra: Partial<MetalsApiOptions> = {}) =>
  metalsApiConnector({ accessKey: KEY, fetch, now: NOW, sleep: async () => {}, historyDays: 45, ...extra });

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}
const historyOf = async (c: ReturnType<typeof connector>, cursor: string | null = null) => collect(c.historicalImport({ organizationId: TEST_ORG, cursor }));
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as MetalPriceEvent[];

describe("Metals-API prices", () => {
  it("turns ounces per dollar into cents per ounce, preferring the direct price", () => {
    expect(centsPerOunce({ XAU: 0.0004 }, "XAU")).toBe(250_000);
    expect(centsPerOunce({ XAU: 0.0004831705, USDXAU: 2069.6627794950227 }, "XAU")).toBe(206_966);
    expect(centsPerOunce({ XAU: 0.5, USDXAU: 2500 }, "XAU")).toBe(250_000);
    expect(centsPerOunce({ USDXAU: 0, XAU: 0.0004 }, "XAU")).toBe(250_000);
  });

  it("skips a quote that is missing, zero, negative, not a number or absurd", () => {
    for (const rates of [{}, { XAU: 0 }, { XAU: -0.001 }, { XAU: Number.NaN }, { XAU: Number.POSITIVE_INFINITY }, { XAU: "0.0004" }, { XAU: 1e-9 }, { XAU: 1000 }]) {
      expect(centsPerOunce(rates as Record<string, number>, "XAU"), JSON.stringify(rates)).toBeNull();
    }
  });

  it("splits the history into 30-day requests, one per metal, ending on the day given", () => {
    const requests = historyRequests("2026-08-21", "2026-10-19");
    expect(requests).toHaveLength(8);
    expect(requests.slice(0, 4).map((r) => r.metal)).toEqual(["gold", "silver", "platinum", "palladium"]);
    expect(requests.filter((r) => r.metal === "gold")).toEqual([
      { metal: "gold", start: "2026-08-21", end: "2026-09-19" },
      { metal: "gold", start: "2026-09-20", end: "2026-10-19" },
    ]);
    expect(historyRequests("2026-10-19", "2026-10-19")).toHaveLength(4);
  });
});

describe("the Metals-API client", () => {
  it("sends only GET requests with no body, in dollars, with the key as access_key", async () => {
    const api = fakeApi();
    const client = metalsApiClient({ accessKey: KEY, fetch: api.fetch });
    await client.latest(["XAU", "XAG"]);
    await client.timeseries("XPT", "2026-10-01", "2026-10-30");
    expect(api.sent.map((s) => [s.method, s.body, s.path])).toEqual([
      ["GET", undefined, "/api/latest"],
      ["GET", undefined, "/api/timeseries"],
    ]);
    expect(api.sent[0]!.query).toEqual({ access_key: KEY, base: "USD", symbols: "XAU,XAG" });
    // The key goes only where Metals-API reads it.
    expect(api.sent.map((s) => s.headers)).toEqual([{ accept: "application/json" }, { accept: "application/json" }]);
    expect(api.sent[1]!.query).toEqual({ access_key: KEY, base: "USD", symbols: "XPT", start_date: "2026-10-01", end_date: "2026-10-30" });
  });

  it("checks the key, the symbols and the dates before sending anything", async () => {
    const api = fakeApi();
    for (const bad of ["", "short", `${KEY}!`, "x".repeat(65)]) expect(() => metalsApiClient({ accessKey: bad, fetch: api.fetch }), bad).toThrow(MetalsApiConfigError);
    const client = metalsApiClient({ accessKey: ` ${KEY} `, fetch: api.fetch });
    await expect(client.latest([])).rejects.toThrow("only XAU, XAG, XPT and XPD");
    await expect(client.latest(["XCU" as "XAU"])).rejects.toThrow(MetalsApiConfigError);
    await expect(client.timeseries("XAU", "2026-10-01", "2026-10-31")).rejects.toThrow("1 to 30 days");
    await expect(client.timeseries("XAU", "2026-10-02", "2026-10-01")).rejects.toThrow("1 to 30 days");
    await expect(client.timeseries("XAU", "10/01/2026", "2026-10-02")).rejects.toThrow("YYYY-MM-DD");
    expect(api.sent).toEqual([]);
  });

  it("names the read in errors, never the URL or the key", async () => {
    const answers = [
      () => Response.json({ success: false, error: { code: 101, info: `Invalid access key ${KEY}` } }),
      () => Response.json({ success: false, error: { code: 401, type: "invalid_access_key" } }, { status: 401 }),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => Response.json({ timestamp: 1, base: "USD", rates: { USDXAU: 2500 } }, { status: 500 }),
      () => Response.json({ success: true, timestamp: 1, base: "EUR", rates: {} }),
      () => Response.json({ success: true, base: "USD", rates: {} }),
      () => Response.json({ success: true, timestamp: 1, base: "USD", rates: null }),
    ];
    const messages: string[] = [];
    for (const latest of answers) {
      const client = metalsApiClient({ accessKey: KEY, fetch: fakeApi({ latest }).fetch });
      const error = await client.latest(["XAU"]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MetalsApiError);
      messages.push((error as Error).message);
    }
    expect(messages).toEqual([
      "Metals-API answered latest with an error: Invalid access key [key]",
      "Metals-API answered latest with HTTP 401: invalid_access_key",
      "Metals-API answered latest with HTTP 502",
      "Metals-API answered latest with HTTP 500",
      "Metals-API answered latest in EUR, not USD",
      "Metals-API latest did not answer with rates",
      "Metals-API latest did not answer with rates",
    ]);
    for (const m of messages) expect(m).not.toContain(KEY);
    const series = metalsApiClient({ accessKey: KEY, fetch: fakeApi({ timeseries: () => Response.json({ success: true, base: "USD" }) }).fetch });
    await expect(series.timeseries("XAU", "2026-10-01", "2026-10-02")).rejects.toThrow("Metals-API timeseries did not answer with rates");
    const coded = await metalsApiClient({ accessKey: KEY, fetch: fakeApi({ latest: answers[0]! }).fetch }).latest(["XAU"]).catch((e: MetalsApiError) => e);
    expect(coded).toMatchObject({ status: 200, code: 101 });
  });

  it("retries a rate limit with backoff, then gives up", async () => {
    let calls = 0;
    const waits: number[] = [];
    const limited = fakeApi({
      latest: () => (++calls <= 2 ? Response.json({ success: false, error: { code: 429, info: "slow down" } }, { status: 429 }) : Response.json({ success: true, timestamp: 1, base: "USD", rates: { USDXAU: 2500 } })),
    });
    const client = metalsApiClient({ accessKey: KEY, fetch: limited.fetch, sleep: async (ms) => void waits.push(ms) });
    expect((await client.latest(["XAU"])).rates).toEqual({ USDXAU: 2500 });
    expect(waits).toEqual([1000, 2000]);
    const always = fakeApi({ latest: () => Response.json({ success: false }, { status: 429 }) });
    const stubborn = metalsApiClient({ accessKey: KEY, fetch: always.fetch, sleep: async () => {}, rateLimitRetries: 1 });
    await expect(stubborn.latest(["XAU"])).rejects.toMatchObject({ status: 429 });
    expect(always.sent).toHaveLength(2);
  });
});

describe("Metals-API connector", () => {
  it("survives every runSync scenario, with every price passing the metals department's schema", async () => {
    const api = fakeApi();
    const result = await checkConnectorSync({ makeConnector: () => connector(api.fetch), payloadSchemas: SCHEMAS, expected: { ingested: 45 * 4 } });
    // 45 days: two stretches of 30 and 15, each for four metals.
    expect(result.full.batches).toBe(8);
    expect(JSON.parse(result.full.cursor!)).toEqual({ through: "2026-10-19", since: "2026-09-05", next: 8 });
  });

  it("reads a daily close for each metal, ending yesterday", async () => {
    const api = fakeApi();
    const events = eventsOf(await historyOf(connector(api.fetch)));
    expect(api.sent.map((s) => [s.query.symbols, s.query.start_date, s.query.end_date])).toEqual([
      ["XAU", "2026-09-05", "2026-10-04"],
      ["XAG", "2026-09-05", "2026-10-04"],
      ["XPT", "2026-09-05", "2026-10-04"],
      ["XPD", "2026-09-05", "2026-10-04"],
      ["XAU", "2026-10-05", "2026-10-19"],
      ["XAG", "2026-10-05", "2026-10-19"],
      ["XPT", "2026-10-05", "2026-10-19"],
      ["XPD", "2026-10-05", "2026-10-19"],
    ]);
    expect(events[0]).toEqual({
      id: "metals_api_gold_day_2026-09-05",
      type: "metal.price_updated",
      occurredAt: "2026-09-05T23:59:59.000Z",
      receivedAt: "2026-10-20T15:00:00.000Z",
      idempotencyKey: "metals_api:gold:day:2026-09-05",
      payload: { metal: "gold", spotPerTroyOunceCents: 250_000, quote: "daily", priceDate: "2026-09-05" },
    });
    const byMetal = (metal: string) => events.filter((e) => e.payload.metal === metal).map((e) => e.payload.spotPerTroyOunceCents);
    expect(new Set(byMetal("silver"))).toEqual(new Set([3_000]));
    expect(new Set(byMetal("platinum"))).toEqual(new Set([100_000]));
    expect(new Set(byMetal("palladium"))).toEqual(new Set([125_000]));
    expect(byMetal("gold")).toHaveLength(45);
    expect(events.filter((e) => e.payload.metal === "gold").map((e) => e.payload.priceDate).at(-1)).toBe("2026-10-19");
  });

  it("keeps only good days inside the stretch asked for, in date order", async () => {
    const api = fakeApi({
      timeseries: (q) =>
        Response.json({
          success: true,
          base: "USD",
          rates: { "2026-10-19": { [q.symbols!]: 0.0005 }, "2026-10-18": { [q.symbols!]: 0.0004 }, "2026-10-17": { [q.symbols!]: 0 }, "2026-10-20": { [q.symbols!]: 0.0004 }, "18 Oct": { [q.symbols!]: 0.0004 } },
        }),
    });
    const events = eventsOf(await historyOf(connector(api.fetch, { historyDays: 3 })));
    expect(events.filter((e) => e.payload.metal === "gold").map((e) => [e.payload.priceDate, e.payload.spotPerTroyOunceCents])).toEqual([
      ["2026-10-18", 250_000],
      ["2026-10-19", 200_000],
    ]);
  });

  it("resumes from its checkpoint with the same end day, even on a later date", async () => {
    const first = fakeApi();
    const batches = await historyOf(connector(first.fetch));
    const cursor = batches[2]!.cursor;
    expect(JSON.parse(cursor)).toEqual({ through: "2026-10-19", since: "2026-09-05", next: 3 });
    const later = fakeApi();
    const rest = await historyOf(connector(later.fetch, { now: () => new Date("2026-10-25T00:00:00Z") }), cursor);
    expect(rest).toHaveLength(5);
    expect(later.sent[0]!.query).toMatchObject({ symbols: "XPD", start_date: "2026-09-05", end_date: "2026-10-04" });
    expect(later.sent.at(-1)!.query).toMatchObject({ end_date: "2026-10-19" });
    // A finished import sends nothing more.
    const done = fakeApi();
    expect(await historyOf(connector(done.fetch), rest.at(-1)!.cursor)).toEqual([]);
    expect(done.sent).toEqual([]);
  });

  it("reads the latest prices for all four metals in one request on each incremental sync", async () => {
    const api = fakeApi();
    const batches = await collect(connector(api.fetch).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.query.symbols).toBe("XAU,XAG,XPT,XPD");
    expect(batches).toHaveLength(1);
    expect(JSON.parse(batches[0]!.cursor)).toEqual({ timestamp: 1_792_500_000 });
    const events = eventsOf(batches);
    const at = new Date(1_792_500_000 * 1000).toISOString();
    expect(events.map((e) => [e.payload.metal, e.payload.spotPerTroyOunceCents, e.payload.quote, e.occurredAt, e.idempotencyKey])).toEqual([
      ["gold", 250_000, "latest", at, `metals_api:gold:at:${at}`],
      ["silver", 3_000, "latest", at, `metals_api:silver:at:${at}`],
      ["platinum", 100_000, "latest", at, `metals_api:platinum:at:${at}`],
      ["palladium", 125_000, "latest", at, `metals_api:palladium:at:${at}`],
    ]);
    expect(events[0]!.payload.priceDate).toBe(at.slice(0, 10));
  });

  it("skips a metal the latest answer leaves out", async () => {
    const api = fakeApi({ latest: () => Response.json({ success: true, timestamp: 1_792_500_000, base: "USD", rates: { XAU: 0.0004, XAG: 0 } }) });
    const events = eventsOf(await collect(connector(api.fetch).incrementalSync({ organizationId: TEST_ORG, cursor: null })));
    expect(events.map((e) => e.payload.metal)).toEqual(["gold"]);
  });

  it("checks its settings, writes nothing back and takes no webhooks", () => {
    const { fetch } = fakeApi();
    for (const historyDays of [0, -1, 1.5, 1826]) expect(() => connector(fetch, { historyDays }), String(historyDays)).toThrow(/historyDays/);
    expect(connector(fetch, { historyDays: 1825 }).source).toBe("metals_api");
    const c = connector(fetch);
    expect(c.writes).toEqual([]);
    expect(c.handleWebhook).toBeUndefined();
    expect(() => metalsApiConnector({ accessKey: "bad", fetch })).toThrow(MetalsApiConfigError);
  });

  it("defaults to a year of history", async () => {
    const api = fakeApi();
    await historyOf(connector(api.fetch, { historyDays: undefined }));
    expect(api.sent[0]!.query.start_date).toBe("2025-10-20");
    expect(api.sent).toHaveLength(13 * 4);
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseMetalsApiCursor(null)).toBeNull();
    const good: MetalsApiCursor = { through: "2026-10-19", since: "2026-09-05", next: 0 };
    expect(parseMetalsApiCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      "null",
      "{}",
      JSON.stringify({ ...good, through: "10/19/2026" }),
      JSON.stringify({ ...good, since: 5 }),
      JSON.stringify({ ...good, since: "2026-10-20" }),
      JSON.stringify({ ...good, next: -1 }),
      JSON.stringify({ ...good, next: 0.5 }),
    ]) {
      expect(() => parseMetalsApiCursor(bad), bad).toThrow("Metals-API checkpoint is not in the expected shape");
    }
  });
});
