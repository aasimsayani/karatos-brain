import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import {
  DOC_MOCK_MODULES,
  NFUSION_MOCK_PRICES,
  NFUSION_RATE_LIMIT_PAGE,
  NFUSION_SPEC_URL,
  TEST_ORG,
  UndocumentedRequestError,
  assertSynthetic,
  checkConnectorSync,
  nfusionDays,
  nfusionDocMock,
  nfusionInterval,
  nfusionSummary,
  testPipeline,
  type NfusionMock,
  type NfusionMockData,
  type NfusionMockRecord,
} from "@karatos/connector-testkit";
import {
  METALS,
  NFUSION_API_BASE,
  NFUSION_HISTORY_PATH,
  NFUSION_MAX_HISTORY_DAYS,
  NFUSION_MIN_INTERVAL_MS,
  NFUSION_RECENT_DAYS,
  NFUSION_SUMMARY_PATH,
  NFUSION_USER_AGENT,
  NFUSION_WINDOW_DAYS,
  NFUSION_WRITES,
  NfusionApiError,
  NfusionConfigError,
  WHATNOT_USER_AGENT,
  isNfusionRateLimit,
  nfusionCents,
  nfusionClient,
  nfusionConnector,
  nfusionDay,
  nfusionDeadLetter,
  nfusionHistoryEvents,
  nfusionMetal,
  nfusionPriceEvent,
  nfusionSummaryEvents,
  nfusionTime,
  nfusionWindows,
  parseNfusionHistoryCursor,
  parseNfusionRecentCursor,
  type NfusionClient,
  type NfusionEvent,
  type NfusionOptions,
} from "../src/index.js";

// A token-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const TOKEN = ["nf", "test", "x".repeat(20)].join("_");
const NOW_ISO = "2026-11-11T15:00:00.000Z";
const NOW = () => new Date(NOW_ISO);
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;
const HEADERS = { accept: "application/json", "user-agent": NFUSION_USER_AGENT };
const CONFIG = "set NFUSION_TOKEN to the API token from the nFusion dashboard (Connections, then API Keys): 8 to 256 letters, digits, _ or -";
const NAMES = "NFUSION_TOKEN must be an API token from the nFusion dashboard (Connections, then API Keys)";
const noSleep = async () => {};

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}
function scripted(responses: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body });
    return responses[Math.min(sent.length - 1, responses.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const text = (status: number, body: string, headers: Record<string, string> = {}) => () => new Response(body, { status, headers });
const empty = json(200, []);
const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => {
  const slept: number[] = [];
  const c = nfusionClient({ token: TOKEN, fetch, sleep: async (ms) => void slept.push(ms), clock: ticking(), ...extra });
  return { c, slept };
};
/** A clock that moves on ten seconds each time it is read, so spacing never waits. */
const ticking = () => {
  let t = 0;
  return () => (t += 10_000);
};

/** Every metal with a close every day from `from` to `through` at its mock price, and a latest quote. */
function market(from: string, through: string, overrides: Partial<NfusionMockData> = {}): NfusionMockData {
  const history: Record<string, NfusionMockRecord[]> = {};
  const spot: Record<string, NfusionMockRecord> = {};
  for (const metal of METALS) {
    history[metal] = nfusionDays(from, through, NFUSION_MOCK_PRICES[metal]!);
    spot[metal] = { symbol: metal, baseCurrency: "USD", timeStamp: "2026-11-11T14:59:00Z", bid: 1, ask: 2, last: NFUSION_MOCK_PRICES[metal], high: 3, low: 0.5 };
  }
  return { token: TOKEN, history, spot, ...overrides };
}
const connector = (mock: NfusionMock, overrides: Partial<NfusionOptions> = {}) => nfusionConnector({ token: TOKEN, fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
async function drain(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as NfusionEvent[];
const historyReads = (mock: NfusionMock) => mock.reads.filter((r) => r.path === NFUSION_HISTORY_PATH).map((r) => `${r.query.start}..${r.query.end}`);

/** A response element as nFusion sends one. */
const element = (data: unknown, over: Record<string, unknown> = {}) => ({ success: true, error: null, requestedSymbol: "gold", requestedCurrency: "USD", requestedUnitOfMeasure: "toz", data, ...over });
const goldSummary = (over: NfusionMockRecord = {}) => {
  nfusionSummary.reset();
  return { ...nfusionSummary.one(), ...over };
};
const day = (start: string, last: unknown, end?: string) => ({ start, end: end ?? new Date(Date.parse(start) + 86_400_000).toISOString(), open: 1, high: 1, low: 1, last });
const goldHistory = (intervals: unknown[], over: Record<string, unknown> = {}) => element({ name: "Gold", symbol: "gold", baseCurrency: "USD", intervals }, over);

describe("nFusion client", () => {
  it("checks its token before sending anything", () => {
    const bad = ["", "x".repeat(7), "x".repeat(257), "abc def ghi", "abcd&efgh", "abcd=efgh", "tokén1234", "abcd.efgh", undefined as unknown as string];
    for (const token of bad) expect(() => nfusionClient({ token }), String(token).slice(0, 10)).toThrow(new NfusionConfigError(CONFIG));
    for (const token of ["x".repeat(8), "x".repeat(256), ` ${TOKEN}\n`, "Ab-9_zZ0"]) expect(() => nfusionClient({ token }), token.slice(0, 10)).not.toThrow();
    expect(new NfusionConfigError("x").name).toBe("NfusionConfigError");
    expect(new NfusionApiError("x", 500)).toMatchObject({ name: "NfusionApiError", status: 500, rateLimited: false });
    expect(new NfusionApiError("x", 403, true).rateLimited).toBe(true);
  });

  it("sends only GETs of the summary and daily history, in USD per troy ounce, with the token in the query and a User-Agent", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    await c.spotSummary(METALS);
    await c.spotHistory(["gold"], "2026-01-01", "2026-03-31");
    await client(fetch, { token: `  ${TOKEN}\t` }).c.spotHistory(["silver", "palladium"], "2026-05-05", "2026-05-05");
    expect(sent.map((s) => s.url)).toEqual([
      `${NFUSION_API_BASE}${NFUSION_SUMMARY_PATH}?metals=gold%2Csilver%2Cplatinum%2Cpalladium&currency=USD&unitofmeasure=toz&format=json&token=${TOKEN}`,
      `${NFUSION_API_BASE}${NFUSION_HISTORY_PATH}?metals=gold&start=2026-01-01&end=2026-03-31&interval=1d&currency=USD&unitofmeasure=toz&format=json&token=${TOKEN}`,
      `${NFUSION_API_BASE}${NFUSION_HISTORY_PATH}?metals=silver%2Cpalladium&start=2026-05-05&end=2026-05-05&interval=1d&currency=USD&unitofmeasure=toz&format=json&token=${TOKEN}`,
    ]);
    expect(sent.every((s) => s.method === "GET" && s.body === undefined)).toBe(true);
    expect(sent.map((s) => s.headers)).toEqual([HEADERS, HEADERS, HEADERS]);
    expect(NFUSION_API_BASE).toBe("https://api.nfusionsolutions.biz");
    expect(NFUSION_SUMMARY_PATH).toBe("/api/v1/Metals/spot/summary");
    expect(NFUSION_HISTORY_PATH).toBe("/api/v1/Metals/spot/history");
    expect(NFUSION_USER_AGENT).toBe(WHATNOT_USER_AGENT);
    expect(Object.keys(c).sort()).toEqual(["spotHistory", "spotSummary"]);
  });

  it("turns down metals and dates it wasn't made for, before sending anything", async () => {
    const { fetch, sent } = scripted([empty]);
    const { c } = client(fetch);
    const metals = "nFusion is asked only for gold, silver, platinum and palladium here, each once";
    for (const m of [[], ["rhodium"], ["gold", "gold"], ["Gold"], ["gold", "copper"]] as unknown as (typeof METALS)[]) {
      await expect(c.spotSummary(m), JSON.stringify(m)).rejects.toThrow(new NfusionApiError(metals, 0));
      await expect(c.spotHistory(m, "2026-01-01", "2026-01-02"), JSON.stringify(m)).rejects.toThrow(metals);
    }
    const dates = "spot history dates must be YYYY-MM-DD, start no later than end";
    for (const [start, end] of [["2026-01-02", "2026-01-01"], ["2026-02-30", "2026-03-01"], ["2026-01-01", "2026-13-01"], ["2026-1-01", "2026-01-02"], ["2026-01-01T00:00:00Z", "2026-01-02"], ["", "2026-01-02"]]) {
      await expect(c.spotHistory(["gold"], start!, end!), `${start} ${end}`).rejects.toThrow(new NfusionApiError(dates, 0));
    }
    expect(sent).toHaveLength(0);
    await c.spotHistory(["gold"], "2024-02-29", "2024-02-29");
    expect(sent).toHaveLength(1);
  });

  it("spaces requests more than a second apart", async () => {
    let now = 5_000;
    const slept: number[] = [];
    const { fetch, sent } = scripted([empty]);
    const c = nfusionClient({ token: TOKEN, fetch, clock: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) });
    await c.spotSummary(["gold"]);
    expect(slept).toEqual([]);
    await c.spotSummary(["gold"]);
    expect(slept).toEqual([NFUSION_MIN_INTERVAL_MS]);
    now += 500;
    await c.spotSummary(["gold"]);
    expect(slept).toEqual([1100, 600]);
    now += 1099;
    await c.spotSummary(["gold"]);
    expect(slept).toEqual([1100, 600, 1]);
    now += 1100;
    await c.spotSummary(["gold"]);
    expect(slept).toEqual([1100, 600, 1]);
    expect(sent).toHaveLength(5);
    expect(NFUSION_MIN_INTERVAL_MS).toBe(1100);
  });

  it("waits out a 429, 5xx or 403.502 as Retry-After says, up to a minute, else 1, 2 and 4 seconds", async () => {
    const waits = async (response: () => Response) => {
      const { fetch, sent } = scripted([response, empty]);
      const { c, slept } = client(fetch);
      expect(await c.spotSummary(["gold"])).toEqual([]);
      expect(sent).toHaveLength(2);
      return slept;
    };
    expect(await waits(json(429, {}, { "retry-after": "1" }))).toEqual([1000]);
    expect(await waits(json(429, {}, { "retry-after": "60" }))).toEqual([60_000]);
    expect(await waits(json(429, {}, { "retry-after": "61" }))).toEqual([60_000]);
    for (const value of ["0", "-1", "1.5", "soon"]) expect(await waits(json(429, {}, { "retry-after": value })), value).toEqual([1000]);
    expect(await waits(json(429, {}))).toEqual([1000]);
    for (const status of [500, 502, 503, 504]) expect(await waits(json(status, {}, { "retry-after": "3" })), String(status)).toEqual([3000]);
    expect(await waits(text(403, NFUSION_RATE_LIMIT_PAGE, { "content-type": "text/html" }))).toEqual([1000]);
    expect(await waits(text(403, NFUSION_RATE_LIMIT_PAGE, { "retry-after": "2" }))).toEqual([2000]);
    expect(await waits(json(403, { error: "Forbidden", subStatus: 502 }))).toEqual([1000]);
    expect(await waits(json(403, {}, { "x-substatus": "502" }))).toEqual([1000]);

    const { fetch, sent } = scripted([json(503, { error: "down" })]);
    const { c, slept } = client(fetch);
    await expect(c.spotSummary(["gold"])).rejects.toThrow(new NfusionApiError("nFusion answered HTTP 503 for the spot summary: down", 503));
    expect([sent.length, slept]).toEqual([4, [1000, 2000, 4000]]);
    const once = scripted([json(501, {})]);
    await expect(client(once.fetch).c.spotSummary(["gold"])).rejects.toMatchObject({ status: 501 });
    expect(once.sent).toHaveLength(1);
    const one = scripted([json(429, {})]);
    await expect(client(one.fetch, { retries: 1 }).c.spotSummary(["gold"])).rejects.toMatchObject({ status: 429 });
    expect(one.sent).toHaveLength(2);
    const zero = scripted([json(429, {})]);
    await expect(client(zero.fetch, { retries: 0 }).c.spotSummary(["gold"])).rejects.toMatchObject({ status: 429 });
    expect(zero.sent).toHaveLength(1);
  });

  it("treats a 403 with substatus 502 as a rate limit, never a token problem, and any other 401 or 403 as the token", async () => {
    const limited = scripted([text(403, NFUSION_RATE_LIMIT_PAGE)]);
    const { c, slept } = client(limited.fetch);
    const error = await c.spotHistory(["gold"], "2026-01-01", "2026-01-02").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(NfusionApiError);
    expect(error).not.toBeInstanceOf(NfusionConfigError);
    expect(error).toMatchObject({ message: "nFusion kept answering the spot history with its rate limit (HTTP 403, substatus 502)", status: 403, rateLimited: true });
    expect([limited.sent.length, slept]).toEqual([4, [1000, 2000, 4000]]);

    const at = async (response: () => Response) => {
      const s = scripted([response]);
      const result = await client(s.fetch).c.spotSummary(["gold"]).then(() => null, (e: unknown) => e as Error);
      expect(s.sent).toHaveLength(1);
      return result;
    };
    expect(await at(text(401, "Unauthorized"))).toEqual(new NfusionConfigError(`nFusion turned down the token (HTTP 401): Unauthorized; ${NAMES}`));
    expect(await at(json(403, [{ success: false, error: "Token expired" }]))).toEqual(new NfusionConfigError(`nFusion turned down the token (HTTP 403): Token expired; ${NAMES}`));
    expect(await at(json(403, { error: "Forbidden", subStatus: 503 }))).toBeInstanceOf(NfusionConfigError);
    expect(await at(text(403, "<html>HTTP Error 403.5020</html>"))).toEqual(new NfusionConfigError(`nFusion turned down the token (HTTP 403); ${NAMES}`));
    expect(await at(json(403, {}, { "x-substatus": "5020" }))).toBeInstanceOf(NfusionConfigError);
    expect(await at(json(401, {}))).toEqual(new NfusionConfigError(`nFusion turned down the token (HTTP 401); ${NAMES}`));
  });

  it("reads the rate limit's substatus from the body or a header, and only on a 403", () => {
    const h = (init: Record<string, string> = {}) => new Headers(init);
    expect(isNfusionRateLimit(403, h(), "HTTP Error 403.502 - Forbidden")).toBe(true);
    expect(isNfusionRateLimit(403, h(), '{"subStatus":502}')).toBe(true);
    expect(isNfusionRateLimit(403, h(), "sub-status = 502")).toBe(true);
    expect(isNfusionRateLimit(403, h(), "SUBSTATUS: 502.")).toBe(true);
    expect(isNfusionRateLimit(403, h({ "x-substatus": " 502 " }), "")).toBe(true);
    expect(isNfusionRateLimit(403, h({ "x-sub-status": "502" }), "")).toBe(true);
    expect(isNfusionRateLimit(429, h({ "x-substatus": "502" }), "403.502")).toBe(false);
    expect(isNfusionRateLimit(502, h(), "403.502")).toBe(false);
    for (const body of ["", "403.503", "403.5021", "1403.502", "403.502x", "substatus 5020", "substatus 503", `substatus${" ".repeat(21)}502`, "status 502"]) expect(isNfusionRateLimit(403, h(), body), body).toBe(false);
    expect(isNfusionRateLimit(403, h(), `substatus${" ".repeat(20)}502`)).toBe(true);
    expect(isNfusionRateLimit(403, h({ "x-status": "502" }), "")).toBe(false);
    expect(isNfusionRateLimit(403, h({ "x-substatus": "503" }), "")).toBe(false);
  });

  it("never puts the token or the URL in an error", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.spotSummary(["gold"]).then(() => null, (e: unknown) => e as Error);
    const echoed = await at(json(400, { error: `bad request for ${NFUSION_API_BASE}${NFUSION_SUMMARY_PATH}?metals=gold&token=${TOKEN}` }));
    expect(echoed?.message).toBe("nFusion answered HTTP 400 for the spot summary: bad request for [url]");
    expect((await at(json(401, { message: `no such token ${TOKEN} here` })))?.message).toBe(`nFusion turned down the token (HTTP 401): no such token [token] here; ${NAMES}`);
    expect((await at(text(400, "see http://example.test/a?b=c then")))?.message).toBe("nFusion answered HTTP 400 for the spot summary: see [url] then");
    expect((await at(text(400, "token=other-value&x=1")))?.message).toBe("nFusion answered HTTP 400 for the spot summary: token=[token]&x=1");
    expect((await at(text(400, "TOKEN = 'abc' rest")))?.message).toBe("nFusion answered HTTP 400 for the spot summary: token=[token] rest");
    expect((await at(text(400, 'with token="abc"')))?.message).toBe("nFusion answered HTTP 400 for the spot summary: with token=[token]");

    const reachable = (async () => {
      throw new TypeError(`fetch failed for ${NFUSION_API_BASE}/?token=${TOKEN}`);
    }) as typeof globalThis.fetch;
    const failed = await client(reachable).c.spotHistory(["gold"], "2026-01-01", "2026-01-02").then(() => null, (e: unknown) => e as Error & { cause?: unknown });
    expect(failed).toEqual(new NfusionApiError("could not reach nFusion for the spot history", 0));
    expect(failed?.cause).toBeUndefined();
    for (const e of [echoed, failed]) {
      expect(JSON.stringify({ message: e?.message, stack: e?.stack })).not.toContain(TOKEN);
      expect(e?.message).not.toContain("api.nfusionsolutions.biz/api/v1/Metals/spot/summary?");
    }
  });

  it("explains other answers, quoting nFusion's words cut short", async () => {
    const at = async (response: () => Response) => client(scripted([response]).fetch, { retries: 0 }).c.spotSummary(["gold"]).then(() => null, (e: unknown) => e as NfusionApiError);
    expect(await at(json(400, [{ success: false, error: "metals is required" }]))).toEqual(new NfusionApiError("nFusion answered HTTP 400 for the spot summary: metals is required", 400));
    expect((await at(json(400, { error: "e".repeat(250) })))?.message).toBe(`nFusion answered HTTP 400 for the spot summary: ${"e".repeat(200)}`);
    expect((await at(json(400, { error: "  two\n\nlines  " })))?.message).toBe("nFusion answered HTTP 400 for the spot summary: two lines");
    expect((await at(json(400, { error: " ", message: "the message", title: "the title" })))?.message).toBe("nFusion answered HTTP 400 for the spot summary: the message");
    expect((await at(json(400, { error: 5, title: "the title" })))?.message).toBe("nFusion answered HTTP 400 for the spot summary: the title");
    expect((await at(json(400, {})))?.message).toBe("nFusion answered HTTP 400 for the spot summary");
    expect((await at(json(400, [])))?.message).toBe("nFusion answered HTTP 400 for the spot summary");
    expect((await at(json(400, [5])))?.message).toBe("nFusion answered HTTP 400 for the spot summary");
    expect((await at(text(404, "  <html><body>Not found</body></html>")))?.message).toBe("nFusion answered HTTP 404 for the spot summary");
    expect((await at(text(500, "")))?.message).toBe("nFusion answered HTTP 500 for the spot summary");
    expect((await at(text(500, "   ")))?.message).toBe("nFusion answered HTTP 500 for the spot summary");
    expect(await at(json(202, []))).toMatchObject({ status: 202 });
    const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error("cut off")) }), { status: 500 });
    expect(await at(broken)).toEqual(new NfusionApiError("nFusion answered HTTP 500 for the spot summary", 500));
    for (const body of [() => new Response("{", { status: 200 }), json(200, {}), json(200, null), json(200, "list"), text(200, "")]) {
      expect(await at(body)).toEqual(new NfusionApiError("nFusion answered the spot summary without a list that reads", 200));
    }
    const fine = scripted([json(200, [{ success: true }])]);
    expect(await client(fine.fetch).c.spotSummary(["gold"])).toEqual([{ success: true }]);
  });

  it("works with the default sleep, clock and fetch", async () => {
    const original = globalThis.fetch;
    const { fetch, sent } = scripted([json(429, {}, { "retry-after": "0" }), empty]);
    globalThis.fetch = fetch;
    try {
      const started = Date.now();
      await nfusionClient({ token: TOKEN }).spotSummary(["gold"]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1090);
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("nFusion values", () => {
  it("reads times, days, prices and metals, and nothing else", () => {
    expect(nfusionTime("2026-11-11T15:30:00Z")).toBe("2026-11-11T15:30:00.000Z");
    expect(nfusionTime("2026-11-11T15:30:00.123456Z")).toBe("2026-11-11T15:30:00.123Z");
    expect(nfusionTime("2026-11-11T10:30:00-05:00")).toBe("2026-11-11T15:30:00.000Z");
    expect(nfusionTime("2026-11-11T15:30")).toBe("2026-11-11T15:30:00.000Z");
    expect(nfusionTime("2026-11-11T15:30:00")).toBe("2026-11-11T15:30:00.000Z");
    for (const v of ["2026-11-11", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-11T25:00:00Z", "2026-11-11 15:30:00Z", "2026-11-11T15:30:00+0500", "x2026-11-11T15:30:00Z", "2026-11-11T15:30:00Zx", "", 1_700_000_000, null, undefined]) {
      expect(nfusionTime(v), String(v)).toBeUndefined();
    }
    expect(nfusionDay("2026-11-11T00:00:00-05:00")).toBe("2026-11-11");
    expect(nfusionDay("2024-02-29T00:00:00Z")).toBe("2024-02-29");
    for (const v of ["2026-02-30T00:00:00Z", "2026-11-11", 5]) expect(nfusionDay(v), String(v)).toBeUndefined();

    expect(nfusionCents(2650.7)).toBe(265_070);
    expect(nfusionCents(0.01)).toBe(1);
    expect(nfusionCents(0.005)).toBe(1);
    expect(nfusionCents(0.0049)).toBeUndefined();
    expect(nfusionCents(1_000_000)).toBe(100_000_000);
    expect(nfusionCents(1_000_000.01)).toBeUndefined();
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "2650", null, undefined]) expect(nfusionCents(v), String(v)).toBeUndefined();

    expect(METALS.map((m) => nfusionMetal(m))).toEqual(["gold", "silver", "platinum", "palladium"]);
    expect(nfusionMetal(" Gold ")).toBe("gold");
    expect(nfusionMetal("PALLADIUM")).toBe("palladium");
    for (const v of ["rhodium", "copper", "", "gold/silver", 5, null]) expect(nfusionMetal(v), String(v)).toBeUndefined();
  });

  it("keys a daily close by metal and day, and a latest quote by metal and time", () => {
    expect(nfusionPriceEvent("gold", 265_070, "daily", "2026-11-02T00:00:00.000Z", "2026-11-01", NOW_ISO)).toEqual({
      id: "nfusion_gold_daily_2026-11-01",
      type: "metal.price_updated",
      occurredAt: "2026-11-02T00:00:00.000Z",
      receivedAt: NOW_ISO,
      idempotencyKey: "nfusion:gold:daily:2026-11-01",
      payload: { metal: "gold", spotPerTroyOunceCents: 265_070, quote: "daily", priceDate: "2026-11-01" },
    });
    expect(nfusionPriceEvent("silver", 3_150, "latest", "2026-11-11T14:59:00.000Z", "2026-11-11", NOW_ISO)).toMatchObject({
      id: "nfusion_silver_latest_2026-11-11T14_59_00_000Z",
      idempotencyKey: "nfusion:silver:latest:2026-11-11T14:59:00.000Z",
      payload: { metal: "silver", spotPerTroyOunceCents: 3_150, quote: "latest", priceDate: "2026-11-11" },
    });
    const dead = nfusionDeadLetter("summary", { a: 1 }, ["x"], NOW_ISO);
    expect(dead).toMatchObject({ type: "metal.price_updated", occurredAt: undefined, receivedAt: NOW_ISO, payload: { system: "nFusion", kind: "summary", problems: ["x"] } });
    expect(dead.idempotencyKey).toMatch(/^nfusion:unreadable_summary:[0-9a-f]{16}$/);
    expect(dead.id).toBe(dead.idempotencyKey.replace(/:/g, "_"));
    expect(nfusionDeadLetter("summary", { a: 1 }, ["y"], "later").idempotencyKey).toBe(dead.idempotencyKey);
    expect(nfusionDeadLetter("summary", { a: 2 }, ["x"], NOW_ISO).idempotencyKey).not.toBe(dead.idempotencyKey);
  });
});

describe("nFusion events", () => {
  const problems = (events: NfusionEvent[]) => events.map((e) => (e.occurredAt === undefined ? (e.payload as { problems: string[] }).problems : "ok"));

  it("gives a latest quote for each summary that reads, with only the metal and price kept", () => {
    const events = nfusionSummaryEvents([element(goldSummary()), element(goldSummary({ symbol: "Silver", last: 31.5, timeStamp: "2026-11-11T09:00:00-05:00" }), { requestedSymbol: "silver" })], NOW_ISO);
    expect(events).toEqual([
      {
        id: "nfusion_gold_latest_2026-11-11T00_01_00_000Z",
        type: "metal.price_updated",
        occurredAt: "2026-11-11T00:01:00.000Z",
        receivedAt: NOW_ISO,
        idempotencyKey: "nfusion:gold:latest:2026-11-11T00:01:00.000Z",
        payload: { metal: "gold", spotPerTroyOunceCents: 265_070, quote: "latest", priceDate: "2026-11-11" },
      },
      expect.objectContaining({ occurredAt: "2026-11-11T14:00:00.000Z", payload: { metal: "silver", spotPerTroyOunceCents: 3_150, quote: "latest", priceDate: "2026-11-11" } }),
    ]);
    // No bid, ask, high or low: the department's schema keeps only the metal and price.
    expect(Object.keys(events[0]!.payload).sort()).toEqual(["metal", "priceDate", "quote", "spotPerTroyOunceCents"]);
    expect(SCHEMAS["metal.price_updated"]!.safeParse(events[0]!.payload).success).toBe(true);
    // The symbol falls back to the requested one only when data has none.
    expect(problems(nfusionSummaryEvents([element({ ...goldSummary(), symbol: undefined })], NOW_ISO))).toEqual(["ok"]);
    expect(problems(nfusionSummaryEvents([element(goldSummary({ symbol: "rhodium" }))], NOW_ISO))).toEqual([["element is not for gold, silver, platinum or palladium"]]);
    expect(nfusionSummaryEvents([element(goldSummary(), { requestedUnitOfMeasure: null }), element(goldSummary(), { requestedUnitOfMeasure: undefined })], NOW_ISO).every((e) => e.occurredAt)).toBe(true);
  });

  it("dead-letters a summary that doesn't read, saying why, and never guesses", () => {
    const at = (raw: unknown) => problems(nfusionSummaryEvents([raw], NOW_ISO))[0];
    expect(at(5)).toEqual(["element is not an object"]);
    expect(at(null)).toEqual(["element is not an object"]);
    expect(at([element(goldSummary())])).toEqual(["element is not an object"]);
    expect(at(element(null, { success: false, error: "  Unknown\nsymbol " }))).toEqual(["nFusion did not answer it: Unknown symbol"]);
    expect(at(element(null, { success: false, error: "e".repeat(300) }))).toEqual([`nFusion did not answer it: ${"e".repeat(200)}`]);
    expect(at(element(goldSummary(), { success: "true" }))).toEqual(["nFusion did not answer it"]);
    expect(at(element(goldSummary(), { success: false, error: 5 }))).toEqual(["nFusion did not answer it"]);
    expect(at(element(null))).toEqual(["element has no data"]);
    expect(at(element([goldSummary()], { requestedSymbol: "rhodium" }))).toEqual(["element has no data", "element is not for gold, silver, platinum or palladium"]);
    expect(at(element(goldSummary({ baseCurrency: "EUR" })))).toEqual(["element is not in USD"]);
    expect(at(element(goldSummary(), { requestedUnitOfMeasure: "g" }))).toEqual(["element is not per troy ounce"]);
    expect(at(element(goldSummary({ timeStamp: "2026-11-11" })))).toEqual(["summary has no timeStamp that reads"]);
    expect(at(element(goldSummary({ last: null })))).toEqual(["summary has no last price that reads"]);
    expect(at(element(goldSummary({ last: 0, timeStamp: null })))).toEqual(["summary has no timeStamp that reads", "summary has no last price that reads"]);
    const dead = nfusionSummaryEvents([element(goldSummary({ last: "2650" }))], NOW_ISO)[0]!;
    expect(dead).toMatchObject({ occurredAt: undefined, payload: { system: "nFusion", kind: "summary" } });
    expect(dead.idempotencyKey).toMatch(/^nfusion:unreadable_summary:/);
  });

  it("gives a daily close for each finished day asked for, and the last day kept", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const intervals = [day("2026-10-31T00:00:00Z", 1), day("2026-11-01T00:00:00Z", 2640.2), day("2026-11-02T00:00:00Z", null), day("2026-11-03T00:00:00Z", 2648.9), day("2026-11-04T00:00:00Z", 2650), day("2026-11-05T00:00:00Z", 3)];
    const read = nfusionHistoryEvents([goldHistory(intervals)], "2026-11-01", "2026-11-05", now, NOW_ISO);
    expect(read.lastDay).toBe("2026-11-03");
    expect(read.events).toEqual([
      nfusionPriceEvent("gold", 264_020, "daily", "2026-11-02T00:00:00.000Z", "2026-11-01", NOW_ISO),
      // The day ending exactly now is over.
      nfusionPriceEvent("gold", 264_890, "daily", "2026-11-04T00:00:00.000Z", "2026-11-03", NOW_ISO),
    ]);
    // A day a millisecond short of over is left for later; the last day asked for is kept.
    expect(nfusionHistoryEvents([goldHistory(intervals)], "2026-11-01", "2026-11-03", new Date(Date.parse("2026-11-04T00:00:00Z") - 1), NOW_ISO).lastDay).toBe("2026-11-01");
    expect(nfusionHistoryEvents([goldHistory(intervals)], "2026-10-31", "2026-10-31", now, NOW_ISO).events.map((e) => e.payload)).toEqual([{ metal: "gold", spotPerTroyOunceCents: 100, quote: "daily", priceDate: "2026-10-31" }]);
    // The vendor's own day is kept, whatever its zone.
    const eastern = nfusionHistoryEvents([goldHistory([day("2026-11-01T00:00:00-05:00", 5, "2026-11-02T00:00:00-05:00")])], "2026-11-01", "2026-11-01", now, NOW_ISO);
    expect(eastern.events[0]).toMatchObject({ occurredAt: "2026-11-02T05:00:00.000Z", payload: { priceDate: "2026-11-01" } });
    expect(nfusionHistoryEvents([goldHistory([])], "2026-11-01", "2026-11-03", now, NOW_ISO)).toEqual({ events: [], lastDay: null });
    // Several metals: the last day is the latest of any.
    const two = nfusionHistoryEvents([goldHistory([day("2026-11-01T00:00:00Z", 1)]), element({ symbol: "silver", baseCurrency: "USD", intervals: [day("2026-11-02T00:00:00Z", 1), day("2026-11-01T00:00:00Z", 1)] })], "2026-11-01", "2026-11-03", now, NOW_ISO);
    expect([two.events.map((e) => e.idempotencyKey), two.lastDay]).toEqual([["nfusion:gold:daily:2026-11-01", "nfusion:silver:daily:2026-11-02", "nfusion:silver:daily:2026-11-01"], "2026-11-02"]);
  });

  it("dead-letters a metal or interval that doesn't read, saying why, and keeps the rest", () => {
    const now = new Date("2026-11-10T00:00:00Z");
    const at = (raw: unknown) => problems(nfusionHistoryEvents([raw], "2026-11-01", "2026-11-05", now, NOW_ISO).events);
    expect(at(5)).toEqual([["element is not an object"]]);
    expect(at(element(null, { success: false, error: "Symbol not supported" }))).toEqual([["nFusion did not answer it: Symbol not supported"]]);
    expect(at(element({ symbol: "gold", baseCurrency: "USD" }))).toEqual([["element has no intervals"]]);
    expect(at(element({ symbol: "gold", baseCurrency: "USD", intervals: {} }))).toEqual([["element has no intervals"]]);
    expect(at(goldHistory([], { requestedUnitOfMeasure: "kg" }))).toEqual([["element is not per troy ounce"]]);
    expect(at(element({ symbol: "gold", baseCurrency: "CAD", intervals: [] }))).toEqual([["element is not in USD"]]);
    expect(
      at(
        goldHistory([
          5,
          day("2026-11-01T00:00:00Z", 1),
          { start: "2026-11-02", end: "2026-11-03T00:00:00Z", last: 1 },
          { start: "2026-11-02T00:00:00Z", end: null, last: 1 },
          { start: null, end: null, last: 1 },
          day("2026-11-03T00:00:00Z", 1, "2026-11-03T00:00:00Z"),
          day("2026-11-03T00:00:00Z", 1, "2026-11-02T23:00:00Z"),
          day("2026-11-03T00:00:00Z", 1, "2026-11-03T00:00:01Z"),
          day("2026-11-04T00:00:00Z", 0),
          day("2026-11-04T00:00:00Z", "2650"),
          day("2026-11-04T00:00:00Z", undefined),
        ]),
      ),
    ).toEqual([
      ["interval is not an object"],
      "ok",
      ["interval has no start that reads"],
      ["interval has no end that reads"],
      ["interval has no start that reads", "interval has no end that reads"],
      ["interval ends before it starts"],
      ["interval ends before it starts"],
      "ok",
      ["interval has no last price that reads"],
      ["interval has no last price that reads"],
    ]);
    const dead = nfusionHistoryEvents([goldHistory([day("2026-11-04T00:00:00Z", -1)])], "2026-11-01", "2026-11-05", now, NOW_ISO);
    expect(dead.lastDay).toBeNull();
    expect(dead.events[0]).toMatchObject({ occurredAt: undefined, payload: { system: "nFusion", kind: "history_interval" } });
    expect(dead.events[0]!.idempotencyKey).toMatch(/^nfusion:unreadable_history_interval:[0-9a-f]{16}$/);
    expect(nfusionHistoryEvents([5], "2026-11-01", "2026-11-05", now, NOW_ISO).events[0]!.idempotencyKey).toMatch(/^nfusion:unreadable_history:/);
    // The same bad interval for two metals is two dead letters.
    const keys = nfusionHistoryEvents([goldHistory([day("2026-11-04T00:00:00Z", -1)]), element({ symbol: "silver", baseCurrency: "USD", intervals: [day("2026-11-04T00:00:00Z", -1)] })], "2026-11-01", "2026-11-05", now, NOW_ISO).events.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("nFusion connector", () => {
  it("passes the shared sync checks", async () => {
    // 100 days of four metals, in two requests.
    const result = await checkConnectorSync({ makeConnector: () => connector(nfusionDocMock(market("2026-07-01", "2026-11-11")), { historyDays: 100 }), payloadSchemas: SCHEMAS, expected: { ingested: 400 } });
    expect(result.full.batches).toBe(2);
    expect(parseNfusionHistoryCursor(result.full.cursor)).toEqual({ since: "2026-08-03", through: "2026-11-10", next: 2 });
  });

  it("imports five years of daily closes ending yesterday, 90 days a request, all four metals at once", async () => {
    const calls: { metals: readonly string[]; start: string; end: string }[] = [];
    const stub: NfusionClient = {
      spotSummary: async () => [],
      spotHistory: async (metals, start, end) => {
        calls.push({ metals, start, end });
        return [];
      },
    };
    const out = await drain(nfusionConnector({ token: TOKEN, client: stub, now: NOW }).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(calls).toHaveLength(21);
    expect(calls[0]).toEqual({ metals: METALS, start: "2021-11-12", end: "2022-02-10" });
    expect(calls[1]).toEqual({ metals: METALS, start: "2022-02-10", end: "2022-05-11" });
    expect(calls.at(-1)).toEqual({ metals: METALS, start: "2026-10-17", end: "2026-11-11" });
    expect(out.map((b) => JSON.parse(b.cursor).next)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(JSON.parse(out[0]!.cursor)).toEqual({ since: "2021-11-12", through: "2026-11-10", next: 1 });
    expect([NFUSION_MAX_HISTORY_DAYS, NFUSION_WINDOW_DAYS, NFUSION_RECENT_DAYS]).toEqual([1825, 90, 7]);
  });

  it("reads into the store with the days asked for and no more, and a replay stores nothing", async () => {
    const mock = nfusionDocMock(market("2026-06-01", "2026-11-11"));
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock, { historyDays: 91 }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 364, deadLettered: 0, duplicates: 0, batches: 2 });
    expect(historyReads(mock)).toEqual(["2026-08-12..2026-11-10", "2026-11-10..2026-11-11"]);
    expect(mock.reads.every((r) => r.query.metals === "gold,silver,platinum,palladium" && r.query.interval === "1d" && r.query.currency === "USD" && r.query.unitofmeasure === "toz")).toBe(true);
    const days = memory.events.filter((e) => e.payload.metal === "gold").map((e) => e.payload.priceDate as string);
    expect([days.length, days[0], days.at(-1)]).toEqual([91, "2026-08-12", "2026-11-10"]);
    expect(memory.events.find((e) => e.payload.metal === "platinum")!.payload).toEqual({ metal: "platinum", spotPerTroyOunceCents: 98_010, quote: "daily", priceDate: "2026-08-12" });
    assertSynthetic(memory.events.map((e) => e.payload));
    const replay = await runSync({ connector: connector(mock, { historyDays: 91 }), mode: "historical", pipeline, memory: Object.create(memory, { getCheckpoint: { value: async () => null } }), organizationId: TEST_ORG });
    expect([replay.ingested, replay.duplicates]).toEqual([0, 364]);
    expect(JSON.stringify(memory.events)).not.toContain(TOKEN);
  });

  it("resumes the import from its checkpoint, asking for the same stretches it fixed at the start", async () => {
    const mock = nfusionDocMock(market("2026-01-01", "2026-11-11"));
    const cursor = JSON.stringify({ since: "2026-03-01", through: "2026-09-30", next: 2 });
    const out = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor }));
    expect(historyReads(mock)).toEqual(["2026-08-28..2026-10-01"]);
    expect(out.map((b) => b.cursor)).toEqual([JSON.stringify({ since: "2026-03-01", through: "2026-09-30", next: 3 })]);
    expect(eventsOf(out).filter((e) => (e.payload as { metal?: string }).metal === "gold").map((e) => (e.payload as { priceDate: string }).priceDate).at(-1)).toBe("2026-09-30");
    const done = await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ since: "2026-03-01", through: "2026-09-30", next: 3 }) }));
    expect(done).toEqual([]);
    const before = Date.now();
    const live = eventsOf(await drain(nfusionConnector({ token: TOKEN, fetch: nfusionDocMock(market("2026-01-01", "2026-12-31")).fetch, sleep: noSleep, historyDays: 1 }).historicalImport({ organizationId: TEST_ORG, cursor: null })));
    expect(live).toHaveLength(4);
    expect(Date.parse(live[0]!.receivedAt)).toBeGreaterThanOrEqual(before);
  });

  it("turns down a history length it can't read", () => {
    for (const historyDays of [0, -1, 1826, 1.5, Number.NaN]) expect(() => nfusionConnector({ token: TOKEN, historyDays }), String(historyDays)).toThrow("historyDays must be a whole number from 1 to 1825");
    for (const historyDays of [1, 1825]) expect(() => nfusionConnector({ token: TOKEN, historyDays })).not.toThrow();
    expect(() => nfusionConnector({ token: "bad" })).toThrow(new NfusionConfigError(CONFIG));
  });

  it("syncs the closes since the last day it kept through today, then the latest summary", async () => {
    const mock = nfusionDocMock(market("2026-10-01", "2026-11-11"));
    const out = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(historyReads(mock)).toEqual(["2026-11-05..2026-11-12"]);
    expect(mock.reads.map((r) => r.path)).toEqual([NFUSION_HISTORY_PATH, NFUSION_SUMMARY_PATH]);
    expect(out.map((b) => b.cursor)).toEqual([JSON.stringify({ day: "2026-11-10" }), JSON.stringify({ day: "2026-11-10" })]);
    const [daily, latest] = out.map((b) => b.events as NfusionEvent[]);
    // Today's close isn't over yet, so the six days to yesterday, for four metals.
    expect(daily!.length).toBe(24);
    expect(latest!.map((e) => e.payload)).toEqual(METALS.map((metal) => ({ metal, spotPerTroyOunceCents: Math.round(NFUSION_MOCK_PRICES[metal]! * 100), quote: "latest", priceDate: "2026-11-11" })));
    expect(latest![0]!.occurredAt).toBe("2026-11-11T14:59:00.000Z");

    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const first = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(first).toMatchObject({ ingested: 28, duplicates: 0, deadLettered: 0, cursor: JSON.stringify({ day: "2026-11-10" }) });
    // The next day: the saved day again (a duplicate), yesterday's close, and a new quote.
    const tomorrow = nfusionDocMock(market("2026-10-01", "2026-11-12", { spot: { gold: { symbol: "gold", baseCurrency: "USD", timeStamp: "2026-11-12T15:00:00Z", last: 2700 } } }));
    const next = await runSync({ connector: connector(tomorrow, { now: () => new Date("2026-11-12T16:00:00Z") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(historyReads(tomorrow)).toEqual(["2026-11-10..2026-11-13"]);
    expect(next).toMatchObject({ ingested: 5, duplicates: 4, deadLettered: 3, cursor: JSON.stringify({ day: "2026-11-11" }) });
  });

  it("reads a long gap in stretches, and keeps its day when nothing new is over", async () => {
    const mock = nfusionDocMock(market("2026-01-01", "2026-11-11"));
    const out = await drain(connector(mock).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ day: "2026-05-01" }) }));
    expect(historyReads(mock)).toEqual(["2026-05-01..2026-07-30", "2026-07-30..2026-10-28", "2026-10-28..2026-11-12"]);
    expect(out.map((b) => JSON.parse(b.cursor).day)).toEqual(["2026-07-29", "2026-10-27", "2026-11-10", "2026-11-10"]);

    const quiet = nfusionDocMock(market("2026-01-01", "2026-11-01"));
    const still = await drain(connector(quiet).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ day: "2026-11-05" }) }));
    expect(still.map((b) => b.cursor)).toEqual([JSON.stringify({ day: "2026-11-05" }), JSON.stringify({ day: "2026-11-05" })]);
    // A day saved after today reads only the summary.
    const ahead = nfusionDocMock(market("2026-01-01", "2026-11-11"));
    const later = await drain(connector(ahead).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ day: "2026-11-12" }) }));
    expect([ahead.reads.map((r) => r.path), later.map((b) => b.cursor)]).toEqual([[NFUSION_SUMMARY_PATH], [JSON.stringify({ day: "2026-11-12" })]]);
    // The first sync with nothing over keeps the first day it asked for.
    const none = await drain(connector(nfusionDocMock(market("2026-11-11", "2026-11-11"))).incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    expect(none.map((b) => b.cursor)).toEqual([JSON.stringify({ day: "2026-11-05" }), JSON.stringify({ day: "2026-11-05" })]);
  });

  it("dead-letters a metal nFusion couldn't answer and keeps the others", async () => {
    const data = market("2026-11-01", "2026-11-11");
    const mock = nfusionDocMock({ ...data, history: { gold: data.history!.gold! }, spot: { silver: data.spot!.silver! } });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 7, deadLettered: 6 });
    expect(memory.deadLetters).toHaveLength(6);
    expect(JSON.stringify(memory.deadLetters)).not.toContain(TOKEN);
  });

  it("waits out nFusion's rate limit within a sync, and stops on a token it turns down without showing it", async () => {
    const slept: number[] = [];
    const mock = nfusionDocMock(market("2026-11-01", "2026-11-11", { rateLimits: 2 }));
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const report = await runSync({ connector: connector(mock, { sleep: async (ms) => void slept.push(ms), clock: ticking() }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 28, deadLettered: 0 });
    expect(slept).toEqual([1000, 2000]);

    const wrong = nfusionDocMock(market("2026-11-01", "2026-11-11", { token: ["nf", "other", "y".repeat(20)].join("_") }));
    const b = testPipeline([], SCHEMAS);
    const error = await runSync({ connector: connector(wrong), mode: "historical", pipeline: b.pipeline, memory: b.memory, organizationId: TEST_ORG, sleep: noSleep }).then(() => null, (e: unknown) => e as Error);
    expect(error).toEqual(new NfusionConfigError(`nFusion turned down the token (HTTP 401): Unauthorized; ${NAMES}`));
    expect(`${error?.message}${error?.stack}`).not.toContain(TOKEN);
  });

  it("has nothing to write, and the API takes no writes", async () => {
    const c = connector(nfusionDocMock(market("2026-11-01", "2026-11-11")));
    expect(c.source).toBe("nfusion");
    expect(c.writes).toBe(NFUSION_WRITES);
    expect(NFUSION_WRITES).toEqual([]);
    // A read-only gate would turn down any write declared here, and none ever runs.
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    const anyWrite = { integration: "nfusion", name: "set_price", description: "Not an nFusion action", kind: "update", approval: "each", dailyCap: 1 } as const;
    await expect(gate.run(anyWrite, "nfusion-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    expect(performed).toBe(false);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });

  it("turns down a checkpoint that isn't its own", () => {
    expect(parseNfusionHistoryCursor(null)).toBeNull();
    expect(parseNfusionRecentCursor(null)).toBeNull();
    const good = [
      { since: "2026-01-01", through: "2026-01-01", next: 0 },
      { since: "2026-01-01", through: "2026-01-01", next: 1 },
      { since: "2026-01-01", through: "2026-12-31", next: 5 },
      { since: "2021-11-12", through: "2026-11-10", next: 21 },
    ];
    for (const c of good) expect(parseNfusionHistoryCursor(JSON.stringify(c))).toEqual(c);
    const badHistory: unknown[] = [
      "{",
      "null",
      "[]",
      "5",
      {},
      { since: "2026-01-01", through: "2026-01-01" },
      { since: "2026-01-01", through: "2026-01-01", next: 0, extra: 1 },
      { since: "2026-01-02", through: "2026-01-01", next: 0 },
      { since: "2026-02-30", through: "2026-03-01", next: 0 },
      { since: "2026-01-01", through: "2026-13-01", next: 0 },
      { since: "2026-1-01", through: "2026-03-01", next: 0 },
      { since: 20260101, through: "2026-03-01", next: 0 },
      { since: "2021-11-11", through: "2026-11-10", next: 0 },
      { since: "2026-01-01", through: "2026-01-01", next: 2 },
      { since: "2026-01-01", through: "2026-12-31", next: 6 },
      { since: "2026-01-01", through: "2026-01-01", next: -1 },
      { since: "2026-01-01", through: "2026-01-01", next: 0.5 },
      { since: "2026-01-01", through: "2026-01-01", next: "0" },
      { day: "2026-01-01" },
      // Another connector's checkpoints.
      { through: "2026-01-01", since: "2026-01-01", next: 0, metal: "gold" },
      { done: true, step: null, page: null },
    ];
    for (const raw of badHistory) expect(() => parseNfusionHistoryCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("nFusion history checkpoint is not in the expected shape");
    expect(parseNfusionRecentCursor(JSON.stringify({ day: "2024-02-29" }))).toEqual({ day: "2024-02-29" });
    const badRecent: unknown[] = ["{", "null", "[]", '"2026-01-01"', {}, { day: "2026-02-30" }, { day: "2026-1-1" }, { day: 5 }, { day: "2026-01-01", extra: 1 }, { since: "2026-01-01", through: "2026-01-01", next: 0 }, { timestamp: 1 }];
    for (const raw of badRecent) expect(() => parseNfusionRecentCursor(typeof raw === "string" ? raw : JSON.stringify(raw)), JSON.stringify(raw)).toThrow("nFusion incremental checkpoint is not in the expected shape");
  });

  it("splits days into stretches of 90 at most", () => {
    expect(nfusionWindows("2026-01-01", "2026-01-01")).toEqual([{ from: "2026-01-01", through: "2026-01-01" }]);
    expect(nfusionWindows("2026-01-01", "2026-03-31")).toEqual([{ from: "2026-01-01", through: "2026-03-31" }]);
    expect(nfusionWindows("2026-01-01", "2026-04-01")).toEqual([
      { from: "2026-01-01", through: "2026-03-31" },
      { from: "2026-04-01", through: "2026-04-01" },
    ]);
    expect(nfusionWindows("2026-01-02", "2026-01-01")).toEqual([]);
  });
});

describe("nFusion doc mock", () => {
  const get = (mock: NfusionMock, path: string, q: Record<string, string>) => mock.fetch(`${NFUSION_API_BASE}${path}?${new URLSearchParams(q)}`);
  const summaryQ = (over: Record<string, string> = {}) => ({ metals: "gold", currency: "USD", unitofmeasure: "toz", format: "json", token: TOKEN, ...over });
  const historyQ = (over: Record<string, string> = {}) => ({ ...summaryQ(), start: "2026-11-01", end: "2026-11-03", interval: "1d", ...over });
  const errorOf = async (r: Response) => [r.status, ((await r.json()) as { error: string }).error];

  it("uses only synthetic data, and says where it came from", () => {
    nfusionInterval.reset();
    const data = market("2026-11-01", "2026-11-03");
    assertSynthetic([data.history, data.spot, nfusionInterval.many(3), goldSummary()]);
    const { mock } = nfusionDocMock(data);
    expect(mock.source).toEqual({ url: NFUSION_SPEC_URL, title: "nFusion Solutions Market Data API OpenAPI spec (apis.guru mirror)", retrievedOn: "2026-11-11", version: "v1" });
    expect(mock.routes.map((r) => `${r.method} ${r.path} ${r.documentedAt}`)).toEqual([`GET /api/v1/Metals/spot/summary ${NFUSION_SPEC_URL}`, `GET /api/v1/Metals/spot/history ${NFUSION_SPEC_URL}`]);
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "nfusion")!;
    expect(module.watchPages).toEqual([NFUSION_SPEC_URL]);
    expect(module.docMocks().map((m) => m.integration)).toEqual(["nfusion"]);
    expect(NFUSION_SPEC_URL).toBe("https://api.apis.guru/v2/specs/nfusionsolutions.biz/1/openapi.json");
    nfusionInterval.reset();
    expect(nfusionInterval.one()).toMatchObject({ start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z", last: 2601 });
  });

  it("checks the token, and answers its rate limit as a 403.502 page", async () => {
    const mock = nfusionDocMock(market("2026-11-01", "2026-11-03", { rateLimits: 1 }));
    expect((await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ token: "wrong-token" }))).status).toBe(401);
    const { token: _drop, ...noToken } = summaryQ();
    expect((await get(mock, NFUSION_SUMMARY_PATH, noToken)).status).toBe(401);
    expect((await nfusionDocMock({ token: "" }).fetch(`${NFUSION_API_BASE}${NFUSION_SUMMARY_PATH}?metals=gold&token=`)).status).toBe(401);
    const limited = await get(mock, NFUSION_SUMMARY_PATH, summaryQ());
    expect([limited.status, await limited.text()]).toEqual([403, NFUSION_RATE_LIMIT_PAGE]);
    expect(isNfusionRateLimit(403, limited.headers, NFUSION_RATE_LIMIT_PAGE)).toBe(true);
    expect((await get(mock, NFUSION_SUMMARY_PATH, summaryQ())).status).toBe(200);
  });

  it("answers each metal with its own success, and history for the days asked for", async () => {
    const mock = nfusionDocMock(market("2026-10-30", "2026-11-05"));
    const summary = (await (await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ metals: "gold,rhodium" }))).json()) as { success: boolean; error: string | null; data: { last: number } | null }[];
    expect(summary.map((e) => [e.success, e.error, e.data?.last])).toEqual([[true, null, 2650.25], [false, "no spot price for rhodium", undefined]]);
    const history = (await (await get(mock, NFUSION_HISTORY_PATH, historyQ({ metals: "silver,copper" }))).json()) as { success: boolean; data: { name: string; intervals: { start: string }[] } | null }[];
    expect(history[0]!.data!.name).toBe("Silver");
    expect(history[0]!.data!.intervals.map((i) => i.start.slice(0, 10))).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(history[1]!.success).toBe(false);
    const { end: _end, ...open } = historyQ();
    const toEnd = (await (await get(mock, NFUSION_HISTORY_PATH, open)).json()) as { data: { intervals: unknown[] } }[];
    expect(toEnd[0]!.data.intervals).toHaveLength(5);
    for (const interval of ["d", "1d"]) expect((await get(mock, NFUSION_HISTORY_PATH, historyQ({ interval }))).status, interval).toBe(200);
    const { interval: _i, currency: _c, unitofmeasure: _u, format: _f, ...bare } = historyQ();
    expect((await get(mock, NFUSION_HISTORY_PATH, bare)).status).toBe(200);
    expect(mock.reads.at(-1)).toEqual({ path: NFUSION_HISTORY_PATH, query: { metals: "gold", start: "2026-11-01", end: "2026-11-03" } });
    expect(JSON.stringify(mock.reads)).not.toContain(TOKEN);
  });

  it("answers 400 for a query the spec doesn't allow or the mock doesn't cover", async () => {
    const mock = nfusionDocMock(market("2026-11-01", "2026-11-03"));
    expect(await errorOf(await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ start: "2026-11-01" })))).toEqual([400, "unknown parameter start"]);
    expect(await errorOf(await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ metals: "" })))).toEqual([400, "metals is required"]);
    expect(await errorOf(await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ unitofmeasure: "lb" })))).toEqual([400, "unitofmeasure is not supported"]);
    expect(await errorOf(await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ format: "csv" })))).toEqual([400, "format must be json or xml"]);
    expect(await errorOf(await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ format: "xml" })))).toEqual([400, "the mock answers only json"]);
    expect(await errorOf(await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ currency: "EUR" })))).toEqual([400, "the mock prices only USD"]);
    expect((await get(mock, NFUSION_SUMMARY_PATH, summaryQ({ unitofmeasure: "g" }))).status).toBe(200);
    const { start: _s, ...noStart } = historyQ();
    expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, noStart))).toEqual([400, "start is required"]);
    expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, historyQ({ start: "Nov 1" })))).toEqual([400, "start is not a date"]);
    expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, historyQ({ end: "2026-10-31" })))).toEqual([400, "end is not a date on or after start"]);
    expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, historyQ({ end: "soon" })))).toEqual([400, "end is not a date on or after start"]);
    expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, historyQ({ interval: "1x" })))).toEqual([400, "interval is not valid"]);
    expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, historyQ({ interval: "0d" })))).toEqual([400, "interval is not valid"]);
    for (const interval of ["6h", "15mi", "w", "2d"]) expect(await errorOf(await get(mock, NFUSION_HISTORY_PATH, historyQ({ interval }))), interval).toEqual([400, "the mock has only daily intervals"]);
    expect((await get(mock, NFUSION_HISTORY_PATH, historyQ({ historicalfx: "true", end: "2026-11-01" }))).status).toBe(200);
  });

  it("throws on a look-alike host and anything the spec doesn't list", async () => {
    const mock = nfusionDocMock(market("2026-11-01", "2026-11-03"));
    await expect(mock.fetch(`https://api.nfusionsolutions.biz.example.test${NFUSION_SUMMARY_PATH}?token=${TOKEN}`)).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${NFUSION_API_BASE}${NFUSION_SUMMARY_PATH}?token=${TOKEN}`, { method: "POST", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${NFUSION_API_BASE}/api/v1/Metals/spot/performance?metals=gold&token=${TOKEN}`)).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
