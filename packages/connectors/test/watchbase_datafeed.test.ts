import { describe, expect, it } from "vitest";
import { InMemoryWriteAuditLog, READ_ONLY, WriteGate, WritesDisabledError, runSync, type SourceBatch } from "@karatos/core";
import {
  DOC_MOCK_MODULES,
  TEST_ORG,
  UndocumentedRequestError,
  WATCHBASE_CREDITS_PER_WATCH,
  WATCHBASE_DOC_PAGES,
  assertSynthetic,
  checkConnectorSync,
  testPipeline,
  watchbaseBrand,
  watchbaseDocMock,
  watchbaseWatch,
  type WatchbaseMock,
  type WatchbaseMockData,
  type WatchbaseMockRecord,
} from "@karatos/connector-testkit";
import {
  WATCHBASE_API_BASE,
  WATCHBASE_BATCH_SIZE,
  WATCHBASE_DEFAULT_MAX_WATCHES,
  WATCHBASE_MAX_BRANDS,
  WATCHBASE_MAX_WATCHES_LIMIT,
  WATCHBASE_USER_AGENT,
  WATCHBASE_WATCH_EVENT,
  WATCHBASE_WRITES,
  WHATNOT_USER_AGENT,
  WatchbaseApiError,
  WatchbaseConfigError,
  isWatchbaseDay,
  isWatchbaseId,
  parseWatchbaseBrands,
  parseWatchbaseCursor,
  parseWatchbaseMaxWatches,
  watchbaseClient,
  watchbaseConnector,
  watchbaseCount,
  watchbaseDay,
  watchbaseHands,
  watchbaseId,
  watchbaseList,
  watchbaseMaterials,
  watchbaseMeasure,
  watchbaseRef,
  watchbaseRoot,
  watchbaseText,
  watchbaseUnlisted,
  watchbaseWatchEvent,
  watchbaseYear,
  type WatchbaseCursor,
  type WatchbaseEvent,
  type WatchbaseOptions,
} from "../src/index.js";

// A key-shaped test value, assembled at runtime so no scanner mistakes the source for a leak.
const KEY = ["test", "k".repeat(24)].join("");
const NOW = () => new Date("2026-11-11T15:30:00.000Z");
const RECEIVED = "2026-11-11T15:30:00.000Z";
const TODAY = "2026-11-11";
const noSleep = async () => {};
const KEY_MESSAGE = "WATCHBASE_API_KEY must be the API key of a WatchBase datafeed account with credits left";

/** Watch `n` of Testmaker 2 (BrandID 902), with explicit ids so the builder's numbering doesn't matter. */
const otherBrand = (n: number): WatchbaseMockRecord => ({
  ...watchbaseWatch.one(),
  wb: { id: 6000 + n, added: "2026-02-01", modified: "2026-02-02", published: "2026-02-02" },
  reference_number: `TM2-${n}`,
  name: `Test Watch ${n}`,
  brand: { id: 902, name: "Testmaker 2" },
  family: { id: 7002, name: "None" },
});

/** 30 watches of Testmaker 1 and 3 of Testmaker 2. */
function store(overrides: Partial<WatchbaseMockData> = {}): WatchbaseMockData {
  watchbaseWatch.reset();
  const first = watchbaseWatch.many(30);
  return { apiKey: KEY, watches: [...first, otherBrand(1), otherBrand(2), otherBrand(3)], ...overrides };
}

const connector = (mock: WatchbaseMock, overrides: Partial<WatchbaseOptions> = {}) => watchbaseConnector({ apiKey: KEY, brands: "Testmaker 1, 902", fetch: mock.fetch, sleep: noSleep, now: NOW, ...overrides });
const eventsOf = (batches: SourceBatch[]) => batches.flatMap((b) => b.events) as WatchbaseEvent[];
const paths = (mock: WatchbaseMock) => mock.reads.map((r) => `${r.path}?${new URLSearchParams(r.query)}`);

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
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const plain = (status: number, text: string) => () => new Response(text, { status });
const LIST = json(200, { num_results: 1, watches: [{ id: 5001 }] });
const client = (fetch: typeof globalThis.fetch, slept: number[] = []) => watchbaseClient({ apiKey: KEY, fetch, sleep: async (ms) => void slept.push(ms) });
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

describe("WatchBase client", () => {
  it("checks the key before sending anything, and never echoes it", () => {
    for (const bad of ["", "   ", "a".repeat(15), "a".repeat(129), `${"a".repeat(20)}&x=1`, `${"a".repeat(20)} b`, `${"a".repeat(20)}=`]) {
      const error = (() => {
        try {
          watchbaseClient({ apiKey: bad, fetch: scripted(LIST).fetch });
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error, bad).toEqual(new WatchbaseConfigError("set WATCHBASE_API_KEY to the API key of a WatchBase datafeed account: 16 to 128 letters, digits, _ or -"));
    }
    for (const good of ["a".repeat(16), "A-b_9".repeat(25) + "abc", ` ${KEY} `]) expect(() => watchbaseClient({ apiKey: good, fetch: scripted(LIST).fetch })).not.toThrow();
    expect("A-b_9".repeat(25).length + 3).toBe(128);
    expect(WATCHBASE_USER_AGENT).toBe(WHATNOT_USER_AGENT);
    expect(new WatchbaseConfigError("x").name).toBe("WatchbaseConfigError");
    expect(new WatchbaseApiError("x", 0).name).toBe("WatchbaseApiError");
  });

  it("sends only GETs, with the key and format in the query, and no authorization header", async () => {
    const { fetch, sent } = scripted(LIST, LIST, json(200, { num_results: 1, brands: [{ id: 1, name: "A" }] }), json(200, { watch: { wb: { id: 1 } } }));
    const c = watchbaseClient({ apiKey: ` ${KEY} `, fetch, sleep: noSleep });
    expect(await c.watches(901, "2026-11-10")).toEqual([{ id: 5001 }]);
    expect(await c.watches(1, null)).toEqual([{ id: 5001 }]);
    expect(await c.brands()).toEqual([{ id: 1, name: "A" }]);
    expect(await c.watch(999_999_999)).toEqual({ wb: { id: 1 } });
    expect(sent.map((s) => s.url)).toEqual([
      `${WATCHBASE_API_BASE}/watches?brand-id=901&updated-since=2026-11-10&format=json&key=${KEY}`,
      `${WATCHBASE_API_BASE}/watches?brand-id=1&format=json&key=${KEY}`,
      `${WATCHBASE_API_BASE}/brands?format=json&key=${KEY}`,
      `${WATCHBASE_API_BASE}/watch?id=999999999&format=json&key=${KEY}`,
    ]);
    expect(WATCHBASE_API_BASE).toBe("https://api.watchbase.com/v1");
    for (const s of sent) {
      expect(s.method).toBe("GET");
      expect(s.headers).toEqual({ accept: "application/json", "user-agent": WATCHBASE_USER_AGENT });
    }
  });

  it("checks ids and days before sending them", async () => {
    const { fetch, sent } = scripted(LIST);
    const c = client(fetch);
    for (const id of [0, -1, 1.5, 1_000_000_000, Number.NaN]) {
      expect(await failure(c.watches(id, null)), String(id)).toEqual(new WatchbaseApiError("a BrandID must be a whole number WatchBase gave", 0));
      expect(await failure(c.watch(id)), String(id)).toEqual(new WatchbaseApiError("a watch id must be a whole number WatchBase gave", 0));
    }
    for (const day of ["2026-02-30", "2026-1-01", "2026-13-01", "", "2026-11-11T00:00:00Z"]) expect(await failure(c.watches(1, day)), day).toEqual(new WatchbaseApiError("updated-since must be a day as YYYY-MM-DD", 0));
    expect(sent).toEqual([]);
    await c.watches(1, "2024-02-29");
    expect(sent).toHaveLength(1);
  });

  it("retries a 429 or 5xx, waiting as Retry-After says up to a minute, else 1, 2 and 4 seconds", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const slept: number[] = [];
      const { fetch, sent } = scripted(json(status, {}), json(status, {}), json(status, {}), LIST);
      expect(await client(fetch, slept).watches(1, null)).toEqual([{ id: 5001 }]);
      expect(sent).toHaveLength(4);
      expect(slept, String(status)).toEqual([1000, 2000, 4000]);
    }
    const waits: [string, number][] = [
      ["5", 5000],
      ["1", 1000],
      ["60", 60_000],
      ["61", 60_000],
      ["600", 60_000],
      ["0", 1000],
      ["-3", 1000],
      ["1.5", 1000],
      ["soon", 1000],
    ];
    for (const [after, ms] of waits) {
      const slept: number[] = [];
      const { fetch } = scripted(json(429, {}, { "retry-after": after }), LIST);
      await client(fetch, slept).watches(1, null);
      expect(slept, after).toEqual([ms]);
    }
    // Retry-After is whole seconds; "5s" isn't, and on a later attempt the wait it gives still counts.
    const slept: number[] = [];
    await client(scripted(json(429, {}, { "retry-after": "5s" }), json(429, {}), json(429, {}, { "retry-after": "1" }), LIST).fetch, slept).watches(1, null);
    expect(slept).toEqual([1000, 2000, 1000]);
  });

  it("gives up after three retries, and doesn't retry other errors", async () => {
    const slept: number[] = [];
    const { fetch, sent } = scripted(json(503, { error: "Down for maintenance" }));
    expect(await failure(client(fetch, slept).watches(1, null))).toEqual(new WatchbaseApiError("WatchBase answered HTTP 503 for the watch list: Down for maintenance", 503));
    expect(sent).toHaveLength(4);
    expect(slept).toEqual([1000, 2000, 4000]);
    for (const retries of [0, 1]) {
      const s = scripted(json(429, {}));
      const c = watchbaseClient({ apiKey: KEY, fetch: s.fetch, sleep: noSleep, retries });
      expect(((await failure(c.brands())) as WatchbaseApiError).status).toBe(429);
      expect(s.sent).toHaveLength(retries + 1);
    }
    for (const status of [400, 404, 409, 501, 505]) {
      const s = scripted(json(status, {}));
      const error = (await failure(client(s.fetch).watch(1))) as WatchbaseApiError;
      expect(error, String(status)).toEqual(new WatchbaseApiError(`WatchBase answered HTTP ${status} for the watch`, status));
      expect(s.sent).toHaveLength(1);
    }
  });

  it("turns a 401 or 403 into a config error naming the setting, with the key, key pairs and URLs masked", async () => {
    for (const status of [401, 403]) {
      const { fetch, sent } = scripted(json(status, { error: `Invalid key ${KEY} for https://api.watchbase.com/v1/watch?id=1&key=${KEY} (key = 'other')` }));
      const error = await failure(client(fetch).watch(1));
      expect(error).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP ${status}): Invalid key [key] for [url] (key=[key]); ${KEY_MESSAGE}`));
      expect(`${error?.message}${error?.stack}`).not.toContain(KEY);
      expect(sent).toHaveLength(1);
    }
    expect(await failure(client(scripted(plain(401, "  Unauthorized\n access  ")).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401): Unauthorized access; ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(plain(403, "<html><body>Forbidden</body></html>")).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 403); ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(json(401, { message: "No credits left" })).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401): No credits left; ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(json(401, { response: { error: { message: "Bad key" } } })).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401): Bad key; ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(json(401, { error: "   " })).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401); ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(json(401, { error: "Bad key", message: "Other" })).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401): Bad key; ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(json(401, { error: " ", message: "No credits left" })).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401): No credits left; ${KEY_MESSAGE}`));
    expect(await failure(client(scripted(plain(403, " \n<html>Forbidden</html>")).fetch).brands())).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 403); ${KEY_MESSAGE}`));
    // Every URL and key pair is masked, whatever its case or scheme.
    const masked = await failure(client(scripted(json(400, { error: "see http://a.example.test/x and HTTPS://b.example.test/y KEY=abc key=def apikey=ghi" })).fetch).watch(1));
    expect(masked?.message).toBe("WatchBase answered HTTP 400 for the watch: see [url] and [url] key=[key] key=[key] apikey=[key]");
    const long = (await failure(client(scripted(json(500, { error: "x".repeat(300) })).fetch).watch(1))) as Error;
    expect(long.message).toBe(`WatchBase answered HTTP 500 for the watch: ${"x".repeat(200)}`);
  });

  it("never puts the URL in an error when WatchBase can't be reached", async () => {
    const fetch = (async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    }) as unknown as typeof globalThis.fetch;
    const error = await failure(client(fetch).watch(1));
    expect(error).toEqual(new WatchbaseApiError("could not reach WatchBase for the watch", 0));
    expect(error?.cause).toBeUndefined();
    expect(`${error?.message}${error?.stack}`).not.toContain(KEY);
  });

  it("turns down answers that don't read, and one that carries an error", async () => {
    const answers: [() => Response, string][] = [
      [plain(200, "<response><num_results>0</num_results></response>"), "WatchBase answered the watch list without JSON that reads"],
      [json(200, [1, 2]), "WatchBase answered the watch list without JSON that reads"],
      [json(200, "text"), "WatchBase answered the watch list without JSON that reads"],
      [json(200, { error: `Out of credits for key=${KEY}` }), "WatchBase answered the watch list with an error: Out of credits for key=[key]"],
      [json(200, { response: { error: "Unknown brand" } }), "WatchBase answered the watch list with an error: Unknown brand"],
      [json(200, { error: 7 }), "WatchBase answered the watch list with an error"],
      [json(200, { num_results: 2 }), "WatchBase answered the watch list without a list that reads"],
      [json(200, { num_results: 2, watches: { watch: "x" } }), "WatchBase answered the watch list without a list that reads"],
    ];
    for (const [answer, message] of answers) expect(await failure(client(scripted(answer).fetch).watches(1, null)), message).toEqual(new WatchbaseApiError(message, 200));
    for (const ok of [{ error: "", watches: [] }, { error: null, watches: [] }]) expect(await client(scripted(json(200, ok)).fetch).watches(1, null)).toEqual([]);
    expect(await failure(client(scripted(json(200, { watch: [] })).fetch).watch(1))).toEqual(new WatchbaseApiError("WatchBase answered the watch without a watch that reads", 200));
    expect(await failure(client(scripted(json(200, { num_results: 1 })).fetch).brands())).toEqual(new WatchbaseApiError("WatchBase answered the brand list without a list that reads", 200));
    expect(await client(scripted(json(200, { response: { watch: { wb: { id: 3 } } } })).fetch).watch(3)).toEqual({ wb: { id: 3 } });
    // Only a 200 is an answer: another 2xx is an error.
    expect(await failure(client(scripted(json(201, { watches: [] })).fetch).watches(1, null))).toEqual(new WatchbaseApiError("WatchBase answered HTTP 201 for the watch list", 201));
    // A body cut off while it is read is an answer without a body.
    const cut = (status: number) => () => new Response(new ReadableStream({ start: (c) => c.error(new Error("cut off")) }), { status });
    expect(await failure(client(scripted(cut(200)).fetch).watch(1))).toEqual(new WatchbaseApiError("WatchBase answered the watch without JSON that reads", 200));
    expect(await failure(client(scripted(cut(500)).fetch).watch(1))).toEqual(new WatchbaseApiError("WatchBase answered HTTP 500 for the watch", 500));
  });

  it("reads the brand and watch lists in each shape", async () => {
    expect(await client(scripted(json(200, { num_results: 2, watches: { watch: [{ id: 1 }, { id: 2 }] } })).fetch).watches(1, null)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await client(scripted(json(200, { response: { num_results: 1, watches: { watch: { id: 1 } } } })).fetch).watches(1, null)).toEqual([{ id: 1 }]);
    expect(await client(scripted(json(200, { response: { num_results: "0", watches: "" } })).fetch).watches(1, null)).toEqual([]);
    expect(await client(scripted(json(200, { num_results: 1, brands: { brand: { id: 1, name: "A" } } })).fetch).brands()).toEqual([{ id: 1, name: "A" }]);
    expect(await client(scripted(json(200, { num_results: 2, brands: { brand: [{ id: 1 }, { id: 2 }] } })).fetch).brands()).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reads a list in each shape XML turned into JSON may give it", () => {
    const a = { id: 1 };
    const b = { id: 2 };
    expect(watchbaseList({ watches: [a, b] }, "watches", "watch")).toEqual([a, b]);
    expect(watchbaseList({ watches: { watch: [a, b] } }, "watches", "watch")).toEqual([a, b]);
    expect(watchbaseList({ watches: { watch: a } }, "watches", "watch")).toEqual([a]);
    expect(watchbaseList({ watches: { watch: null } }, "watches", "watch")).toBeUndefined();
    expect(watchbaseList({ watches: { other: a } }, "watches", "watch")).toBeUndefined();
    for (const none of [undefined, null, "", {}]) {
      expect(watchbaseList({ num_results: 0, watches: none }, "watches", "watch")).toEqual([]);
      expect(watchbaseList({ num_results: "0", watches: none }, "watches", "watch")).toEqual([]);
      expect(watchbaseList({ num_results: 1, watches: none }, "watches", "watch")).toBeUndefined();
      expect(watchbaseList({ watches: none }, "watches", "watch")).toBeUndefined();
    }
    expect(watchbaseList({ num_results: 0, watches: 5 }, "watches", "watch")).toBeUndefined();
    expect(watchbaseList({ num_results: 0, watches: { other: a } }, "watches", "watch")).toBeUndefined();
    expect(watchbaseRoot({ response: { a: 1 } })).toEqual({ a: 1 });
    expect(watchbaseRoot({ response: [1], a: 2 })).toEqual({ response: [1], a: 2 });
    expect(watchbaseRoot({ a: 1 })).toEqual({ a: 1 });
    for (const v of [null, [1], "x", 3]) expect(watchbaseRoot(v)).toBeUndefined();
  });

  it("knows a WatchBase id and day", () => {
    for (const v of [1, 9, 999_999_999]) expect(isWatchbaseId(v), String(v)).toBe(true);
    for (const v of [0, -1, 1.5, 1_000_000_000, "1", Number.NaN, Number.POSITIVE_INFINITY, null]) expect(isWatchbaseId(v), String(v)).toBe(false);
    for (const v of ["2026-11-11", "2024-02-29", "1999-12-31"]) expect(isWatchbaseDay(v), v).toBe(true);
    // "-000001-01" reads back as itself through Date, so only the pattern turns it down.
    for (const v of ["2025-02-29", "2026-02-30", "2026-00-10", "2026-1-1", " 2026-11-11", "2026-11-11Z", "-000001-01", "+002026-11", 20261111, null]) expect(isWatchbaseDay(v), String(v)).toBe(false);
  });
});

describe("WatchBase events", () => {
  it("keeps a watch's specs and nothing else", () => {
    watchbaseWatch.reset();
    const raw = watchbaseWatch.one();
    const read = watchbaseWatchEvent(raw, RECEIVED);
    expect(read.ok).toBe(true);
    expect(read.event.type).toBe(WATCHBASE_WATCH_EVENT);
    expect(WATCHBASE_WATCH_EVENT).toBe("watch_reference.updated");
    expect(read.event.occurredAt).toBe("2026-01-02T00:00:00.000Z");
    expect(read.event.receivedAt).toBe(RECEIVED);
    expect(read.event.payload).toEqual({
      system: "WatchBase",
      watchId: "watchbase:watch:5001",
      brand: "Testmaker 1",
      brandId: "watchbase:brand:901",
      reference: "TM-1",
      name: "Test Diver 1",
      family: "Test Series",
      familyId: "watchbase:family:7001",
      gender: "M",
      released: 2020,
      waterResistanceM: 100,
      caliber: { reference: "TC-1", maker: "Testworks", type: "Automatic", display: "Analog", jewels: 21, diameterMm: 26, powerReserveHours: 40, hands: ["Hours", "Minutes", "Seconds"] },
      case: { materials: ["Stainless steel"], coating: "PVD", glass: "Sapphire", back: "Closed", shape: "Round", diameterMm: 40, heightMm: 12.5, lugWidthMm: 20 },
      dial: { color: "Black", finish: "Matte", indexType: "Stick", handStyle: "Sword" },
      added: "2026-01-01",
      modified: "2026-01-02",
    });
    expect(JSON.stringify(read.event.payload)).not.toMatch(/description|example\.test|png|slug|EUR/);
    expect(read.event.idempotencyKey).toMatch(/^watchbase:watch:5001:2026-01-02:[0-9a-f]{16}$/);
    expect(read.event.id).toBe(read.event.idempotencyKey.replace(/:/g, "_"));
    assertSynthetic(read.event.payload);
  });

  it("keys a watch by its id, modified day and what was kept", () => {
    watchbaseWatch.reset();
    const raw = watchbaseWatch.one();
    const key = (r: WatchbaseMockRecord) => watchbaseWatchEvent(r, RECEIVED).event.idempotencyKey;
    expect(key(raw)).toBe(key(structuredClone(raw)));
    expect(watchbaseWatchEvent(raw, "2027-01-01T00:00:00.000Z").event.idempotencyKey).toBe(key(raw));
    // What isn't kept doesn't change the key; what is kept does.
    expect(key({ ...raw, description: "Changed", stopped: "10" })).toBe(key(raw));
    expect(key({ ...raw, name: "Renamed" })).not.toBe(key(raw));
    expect(key({ ...raw, dial: { ...(raw.dial as object), color: "Blue" } })).not.toBe(key(raw));
    expect(key({ ...raw, wb: { ...(raw.wb as object), modified: "2026-03-01" } })).toMatch(/^watchbase:watch:5001:2026-03-01:/);
  });

  it("leaves out what doesn't read, and groups with nothing in them", () => {
    const read = watchbaseWatchEvent({ wb: { id: "42", modified: "2026-05-05", added: "2026-02-30" }, reference_number: 5711, brand: { id: "7", name: " Test  Brand " }, family: { id: 0, name: "None" }, released: "1699", gender: "", waterresistance: "30.00 mm", caliber: { jewels: "1000", hands: " , " }, case: { materials: { material: [] } }, dial: {} }, RECEIVED);
    expect(read.ok).toBe(true);
    expect(read.event.payload).toEqual({ system: "WatchBase", watchId: "watchbase:watch:42", brand: "Test Brand", brandId: "watchbase:brand:7", reference: "5711", modified: "2026-05-05" });
    expect(watchbaseWatchEvent({ wb: { id: 1, modified: "2026-05-05" }, reference_number: "R", brand: { id: 1, name: "B" }, family: { name: "Test Family" } }, RECEIVED).event.payload).toMatchObject({ family: "Test Family" });
    expect(watchbaseWatchEvent({ wb: { id: 1, modified: "2026-05-05" }, reference_number: "R", brand: { id: 1, name: "B" }, family: { name: "none" } }, RECEIVED).event.payload).not.toHaveProperty("family");
  });

  it("dead-letters a watch without an id, reference number, brand or modified day, listing each", () => {
    const good = { wb: { id: 1, modified: "2026-05-05" }, reference_number: "R", brand: { id: 1, name: "B" } };
    const cases: [unknown, string[]][] = [
      [{ ...good, wb: { modified: "2026-05-05" } }, ["no watch id"]],
      [{ ...good, wb: { id: 0, modified: "2026-05-05" } }, ["no watch id"]],
      [{ ...good, reference_number: "  " }, ["no reference number"]],
      [{ ...good, brand: { id: 1 } }, ["no brand id and name"]],
      [{ ...good, brand: { id: "x", name: "B" } }, ["no brand id and name"]],
      [{ ...good, wb: { id: 1, modified: "2026-02-30" } }, ["no modified day"]],
      [null, ["no watch id", "no reference number", "no brand id and name", "no modified day"]],
      ["text", ["no watch id", "no reference number", "no brand id and name", "no modified day"]],
    ];
    for (const [raw, problems] of cases) {
      const read = watchbaseWatchEvent(raw, RECEIVED);
      expect(read.ok, JSON.stringify(raw)).toBe(false);
      expect(read.event.occurredAt).toBeUndefined();
      expect(read.event.payload).toEqual({ system: "WatchBase", kind: "watch", problems });
      expect(read.event.idempotencyKey).toMatch(/^watchbase:unreadable_watch:[0-9a-f]{12}$/);
      expect(read.event.idempotencyKey).toBe(watchbaseWatchEvent(raw, "2030-01-01T00:00:00.000Z").event.idempotencyKey);
      expect(read.event.id).toBe(read.event.idempotencyKey.replace(/:/g, "_"));
    }
    // The id is the one under wb, never one at the top.
    expect(watchbaseWatchEvent({ ...good, id: 1, wb: { modified: "2026-05-05" } }, RECEIVED).event.payload.problems).toEqual(["no watch id"]);
    expect(watchbaseWatchEvent(good, RECEIVED).ok).toBe(true);
    const listed = watchbaseUnlisted({ refnr: "X" }, 901, RECEIVED);
    expect(listed).toMatchObject({ type: WATCHBASE_WATCH_EVENT, occurredAt: undefined, payload: { system: "WatchBase", kind: "listed_watch", problems: ["a watch listed for BrandID 901 has no id"] } });
    expect(listed.idempotencyKey).toMatch(/^watchbase:unreadable_listed_watch:[0-9a-f]{12}$/);
    expect(watchbaseUnlisted({ refnr: "X" }, 902, RECEIVED).idempotencyKey).not.toBe(listed.idempotencyKey);
  });

  it("cuts each text field at its own length", () => {
    const long = (c: string) => c.repeat(130);
    const raw = {
      wb: { id: 1, modified: "2026-05-05" },
      reference_number: long("r"),
      name: long("n"),
      gender: long("g"),
      brand: { id: 1, name: long("b") },
      caliber: { reference_number: long("c"), brand: long("m"), type: long("t"), display: long("d"), hands: `${long("h")},Minutes` },
      case: { materials: { material: [long("s")] }, coating: long("o"), glass: long("l"), back: long("k"), shape: long("p") },
      dial: { color: long("C"), finish: long("F"), indextype: long("I"), handstyle: long("H") },
    };
    const p = watchbaseWatchEvent(raw, RECEIVED).event.payload as Record<string, Record<string, unknown>>;
    const lengths = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map((x: string) => x.length) : typeof v === "string" ? v.length : v]));
    expect(lengths({ reference: p.reference, name: p.name, gender: p.gender, brand: p.brand })).toEqual({ reference: 60, name: 120, gender: 20, brand: 80 });
    expect(lengths(p.caliber!)).toEqual({ reference: 60, maker: 80, type: 40, display: 40, hands: [40, 7] });
    expect(lengths(p.case!)).toEqual({ materials: [60], coating: 60, glass: 60, back: 60, shape: 60 });
    expect(lengths(p.dial!)).toEqual({ color: 60, finish: 60, indexType: 60, handStyle: 60 });
  });

  it("reads ids, text, days, counts and years at their edges", () => {
    expect([1, "1", 999_999_999, "999999999"].map(watchbaseId)).toEqual([1, 1, 999_999_999, 999_999_999]);
    for (const v of [0, "0", "01", 1_000_000_000, "1000000000", 1.5, "1.5", -1, " 1", null, undefined, {}, [1], ["1"]]) expect(watchbaseId(v), String(v)).toBeUndefined();
    expect(watchbaseText("  a \n b  ")).toBe("a b");
    expect(watchbaseText("abcdef", 3)).toBe("abc");
    expect(watchbaseText(5711)).toBe("5711");
    expect(watchbaseText(123_456, 3)).toBe("123");
    for (const v of ["", "   ", null, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) expect(watchbaseText(v), String(v)).toBeUndefined();
    expect(watchbaseText("x".repeat(121))).toBe("x".repeat(120));
    expect(watchbaseDay("2026-11-11")).toBe("2026-11-11");
    expect(watchbaseDay("2026-11-31")).toBeUndefined();
    expect([0, 999, "21", " 7 "].map(watchbaseCount)).toEqual([0, 999, 21, 7]);
    for (const v of [1000, "021", -1, 1.5, "", null]) expect(watchbaseCount(v), String(v)).toBeUndefined();
    expect([1700, 2100, "2015", " 1999 "].map(watchbaseYear)).toEqual([1700, 2100, 2015, 1999]);
    for (const v of [1699, 2101, "15", "2015.0", null]) expect(watchbaseYear(v), String(v)).toBeUndefined();
  });

  it("reads a measurement only with its own unit", () => {
    expect(watchbaseMeasure("49.70 mm", "mm")).toBe(49.7);
    expect(watchbaseMeasure("26mm", "mm")).toBe(26);
    expect(watchbaseMeasure(" 12.85 MM ", "mm")).toBe(12.85);
    expect(watchbaseMeasure("30.00 m", "m")).toBe(30);
    expect(watchbaseMeasure("40 h", "h")).toBe(40);
    expect(watchbaseMeasure("0 h", "h")).toBe(0);
    expect(watchbaseMeasure("99999.999 m", "m")).toBe(99_999.999);
    for (const [v, unit] of [
      ["30.00 mm", "m"],
      ["30.00 m", "mm"],
      ["40 hours", "h"],
      ["100000 m", "m"],
      ["1.2345 mm", "mm"],
      ["01 mm", "mm"],
      ["-1 mm", "mm"],
      ["mm", "mm"],
      ["1. mm", "mm"],
      ["", "mm"],
    ] as const)
      expect(watchbaseMeasure(v, unit), `${v} ${unit}`).toBeUndefined();
    expect(watchbaseMeasure(26, "mm")).toBeUndefined();
  });

  it("reads materials and hands in each shape", () => {
    expect(watchbaseMaterials({ material: "Steel" })).toEqual(["Steel"]);
    expect(watchbaseMaterials({ material: ["Steel", " Gold ", "Steel", "", 3] })).toEqual(["Steel", "Gold", "3"]);
    expect(watchbaseMaterials(["Titanium"])).toEqual(["Titanium"]);
    expect(watchbaseMaterials("Ceramic")).toEqual(["Ceramic"]);
    for (const v of [undefined, null, {}, { material: [] }, { other: "Steel" }, [], ""]) expect(watchbaseMaterials(v), JSON.stringify(v)).toBeUndefined();
    expect(watchbaseHands("Hours,Minutes , ,Seconds")).toEqual(["Hours", "Minutes", "Seconds"]);
    expect(watchbaseHands("Hours; Minutes")).toEqual(["Hours; Minutes"]);
    for (const v of ["", " , ", ["Hours"], null]) expect(watchbaseHands(v), JSON.stringify(v)).toBeUndefined();
    expect(watchbaseRef("brand", 37)).toBe("watchbase:brand:37");
  });
});

describe("WatchBase settings and checkpoint", () => {
  it("reads the brands to follow", () => {
    expect(parseWatchbaseBrands(" Testmaker 1, 37\n testmaker 1 ,\n\n37, 999999999, Other ")).toEqual([{ name: "Testmaker 1" }, { id: 37 }, { id: 999_999_999 }, { name: "Other" }]);
    expect(parseWatchbaseBrands("x".repeat(80))).toEqual([{ name: "x".repeat(80) }]);
    expect(parseWatchbaseBrands("1st Test Brand, Test; Brand")).toEqual([{ name: "1st Test Brand" }, { name: "Test; Brand" }]);
    expect(parseWatchbaseBrands(Array.from({ length: WATCHBASE_MAX_BRANDS }, (_, i) => String(i + 1)).join(","))).toHaveLength(50);
    const bad: [string, string][] = [
      ["", "WATCHBASE_BRANDS lists no brand"],
      [" , \n ", "WATCHBASE_BRANDS lists no brand"],
      ["0", "WATCHBASE_BRANDS has a BrandID that isn't a whole number from 1 to 999999999"],
      ["037", "WATCHBASE_BRANDS has a BrandID that isn't a whole number from 1 to 999999999"],
      ["1000000000", "WATCHBASE_BRANDS has a BrandID that isn't a whole number from 1 to 999999999"],
      ["x".repeat(81), "WATCHBASE_BRANDS has a brand name that isn't plain text up to 80 characters"],
      ["Test\tBrand", "WATCHBASE_BRANDS has a brand name that isn't plain text up to 80 characters"],
      ["Test\u007fBrand", "WATCHBASE_BRANDS has a brand name that isn't plain text up to 80 characters"],
      ["Test\u0000Brand", "WATCHBASE_BRANDS has a brand name that isn't plain text up to 80 characters"],
      ["Test\u001fBrand", "WATCHBASE_BRANDS has a brand name that isn't plain text up to 80 characters"],
      [Array.from({ length: WATCHBASE_MAX_BRANDS + 1 }, (_, i) => String(i + 1)).join(","), "WATCHBASE_BRANDS lists more than 50 brands"],
    ];
    for (const [raw, message] of bad) expect(() => parseWatchbaseBrands(raw), raw).toThrow(new WatchbaseConfigError(message));
  });

  it("reads the most watches a sync reads", () => {
    expect(parseWatchbaseMaxWatches(undefined)).toBe(WATCHBASE_DEFAULT_MAX_WATCHES);
    expect(parseWatchbaseMaxWatches("  ")).toBe(200);
    expect(parseWatchbaseMaxWatches("1")).toBe(1);
    expect(parseWatchbaseMaxWatches(" 10000 ")).toBe(WATCHBASE_MAX_WATCHES_LIMIT);
    for (const raw of ["0", "10001", "1.5", "-1", "01", "1e3", "ten"]) expect(() => parseWatchbaseMaxWatches(raw), raw).toThrow(new WatchbaseConfigError("WATCHBASE_MAX_WATCHES must be a whole number from 1 to 10000"));
    const mock = watchbaseDocMock(store());
    for (const maxWatches of [0, 10_001, 1.5, Number.NaN]) expect(() => connector(mock, { maxWatches }), String(maxWatches)).toThrow(new WatchbaseConfigError("WATCHBASE_MAX_WATCHES must be a whole number from 1 to 10000"));
    for (const maxWatches of [1, 10_000]) expect(() => connector(mock, { maxWatches })).not.toThrow();
  });

  it("turns down a checkpoint that isn't its own", async () => {
    expect(parseWatchbaseCursor(null)).toBeNull();
    const good: WatchbaseCursor[] = [
      { synced: [], pass: null },
      { synced: [[1, "2026-11-10"]], pass: null },
      { synced: [[901, "2026-11-11"]], pass: { started: "2026-11-11", brand: 902, after: 6001 } },
      { synced: [], pass: { started: "2026-11-11", brand: null, after: 0 } },
      { synced: [], pass: { started: "2026-11-11", brand: 1, after: 0 } },
      { synced: Array.from({ length: WATCHBASE_MAX_BRANDS }, (_, i) => [i + 1, "2026-11-11"] as [number, string]), pass: null },
    ];
    for (const c of good) expect(parseWatchbaseCursor(JSON.stringify(c))).toEqual(c);
    const pass = { started: "2026-11-11", brand: 1, after: 2 };
    const bad: unknown[] = [
      "",
      "{",
      "null",
      "[]",
      "5",
      {},
      { synced: [] },
      { pass: null },
      { synced: [], pass: null, extra: 1 },
      { done: true, synced: [], pass: null },
      { synced: {}, pass: null },
      { synced: [[0, "2026-11-11"]], pass: null },
      { synced: [["1", "2026-11-11"]], pass: null },
      { synced: [[1, "2026-02-30"]], pass: null },
      { synced: [[1]], pass: null },
      { synced: [[1, "2026-11-11", 3]], pass: null },
      { synced: [[1, "2026-11-11"], [1, "2026-11-10"]], pass: null },
      { synced: Array.from({ length: WATCHBASE_MAX_BRANDS + 1 }, (_, i) => [i + 1, "2026-11-11"]), pass: null },
      { synced: [], pass: [] },
      { synced: [], pass: "open" },
      { synced: [], pass: false },
      { synced: [], pass: 0 },
      { synced: [], pass: "" },
      { synced: [], pass: { ...pass, extra: 1 } },
      { synced: [], pass: { started: "2026-11-11", brand: 1 } },
      { synced: [], pass: { ...pass, started: "2026-13-01" } },
      { synced: [], pass: { ...pass, brand: 0 } },
      { synced: [], pass: { ...pass, brand: "1" } },
      { synced: [], pass: { ...pass, after: -1 } },
      { synced: [], pass: { ...pass, after: 1.5 } },
      { synced: [], pass: { ...pass, brand: null, after: 5 } },
    ];
    const c = connector(watchbaseDocMock(store()));
    for (const raw of bad) {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      expect(() => parseWatchbaseCursor(text), text).toThrow("WatchBase checkpoint is not in the expected shape");
      expect(await failure(drain(c.incrementalSync({ organizationId: TEST_ORG, cursor: text }))), text).toEqual(new Error("WatchBase checkpoint is not in the expected shape"));
    }
    expect(await failure(drain(c.historicalImport({ organizationId: TEST_ORG, cursor: "{" })))).toEqual(new Error("WatchBase checkpoint is not in the expected shape"));
  });
});

describe("WatchBase connector", () => {
  const sync = (c: ReturnType<typeof connector>, cursor: WatchbaseCursor | string | null = null) => drain(c.incrementalSync({ organizationId: TEST_ORG, cursor: cursor === null || typeof cursor === "string" ? cursor : JSON.stringify(cursor) }));

  it("passes the shared sync checks", async () => {
    const result = await checkConnectorSync({ mode: "incremental", makeConnector: () => connector(watchbaseDocMock(store())), expected: { ingested: 33 } });
    expect(result.full).toMatchObject({ batches: 3, deadLettered: 0 });
    expect(result.resume!.ingested).toBe(8);
    expect(parseWatchbaseCursor(result.full.cursor)).toEqual({
      synced: [
        [901, TODAY],
        [902, TODAY],
      ],
      pass: null,
    });
  });

  it("reads nothing in the historical import, which the runner runs once", async () => {
    const mock = watchbaseDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, batches: 0, cursor: null });
    expect(mock.fetch.calls).toEqual([]);
    expect(await drain(connector(mock).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify({ synced: [], pass: null }) }))).toEqual([]);
  });

  it("reads every watch of each brand the first time, 25 to a batch, looking names up once", async () => {
    const mock = watchbaseDocMock(store());
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 33, deadLettered: 0, batches: 3 });
    const reads = paths(mock);
    expect(reads.slice(0, 2)).toEqual(["/v1/brands?format=json", "/v1/watches?brand-id=901&format=json"]);
    expect(reads.slice(2, 32)).toEqual(Array.from({ length: 30 }, (_, i) => `/v1/watch?id=${5001 + i}&format=json`));
    expect(reads.slice(32)).toEqual(["/v1/watches?brand-id=902&format=json", "/v1/watch?id=6001&format=json", "/v1/watch?id=6002&format=json", "/v1/watch?id=6003&format=json"]);
    expect(mock.creditsUsed).toBe(33 * WATCHBASE_CREDITS_PER_WATCH);
    expect(memory.events.every((e) => e.type === WATCHBASE_WATCH_EVENT)).toBe(true);
    for (const e of memory.events) assertSynthetic(e.payload);
    expect(memory.events.find((e) => e.payload.watchId === "watchbase:watch:6001")!.payload).not.toHaveProperty("family");
    // The same day, every brand has been read, so another sync reads no watch.
    const before = mock.reads.length;
    const again = await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(again).toMatchObject({ ingested: 0, duplicates: 0, batches: 1, cursor: report.cursor });
    expect(paths(mock).slice(before)).toEqual(["/v1/brands?format=json"]);
    expect(mock.creditsUsed).toBe(33 * WATCHBASE_CREDITS_PER_WATCH);
  });

  it("gives each batch a checkpoint it can resume from", async () => {
    const mock = watchbaseDocMock(store());
    const batches = await sync(connector(mock));
    expect(batches.map((b) => b.events.length)).toEqual([WATCHBASE_BATCH_SIZE, 5, 3]);
    expect(batches.map((b) => parseWatchbaseCursor(b.cursor))).toEqual([
      { synced: [], pass: { started: TODAY, brand: 901, after: 5025 } },
      { synced: [[901, TODAY]], pass: { started: TODAY, brand: null, after: 0 } },
      { synced: [[901, TODAY], [902, TODAY]], pass: null },
    ]);
    // A resumed pass keeps the day it began, though it goes on later.
    const rest = await sync(connector(mock, { now: () => new Date("2026-11-13T01:00:00.000Z") }), batches[0]!.cursor);
    expect(eventsOf(rest).map((e) => e.payload.watchId)).toEqual([...[26, 27, 28, 29, 30].map((n) => `watchbase:watch:${5000 + n}`), "watchbase:watch:6001", "watchbase:watch:6002", "watchbase:watch:6003"]);
    expect(rest.at(-1)!.cursor).toBe(batches.at(-1)!.cursor);
  });

  it("later reads only what changed since the day before each brand was read, and a new version is a new event", async () => {
    const data = store();
    const mock = watchbaseDocMock(data);
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // Two watches change: one on the 11th, after the first read began, and one on the 10th.
    const w = data.watches!;
    w[2] = { ...w[2]!, name: "Renamed 3", wb: { ...(w[2]!.wb as object), modified: "2026-11-11" } };
    w[31] = { ...w[31]!, wb: { ...(w[31]!.wb as object), modified: "2026-11-10" } };
    const before = mock.reads.length;
    const credits = mock.creditsUsed;
    const later = await runSync({ connector: connector(mock, { now: () => new Date("2026-11-12T08:00:00.000Z") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(paths(mock).slice(before)).toEqual(["/v1/brands?format=json", "/v1/watches?brand-id=901&updated-since=2026-11-10&format=json", "/v1/watch?id=5003&format=json", "/v1/watches?brand-id=902&updated-since=2026-11-10&format=json"]);
    expect(mock.creditsUsed - credits).toBe(WATCHBASE_CREDITS_PER_WATCH);
    expect(later).toMatchObject({ ingested: 1 });
    expect(memory.events.filter((e) => e.payload.watchId === "watchbase:watch:5003").map((e) => e.payload.name)).toEqual(["Test Diver 3", "Renamed 3"]);
    expect(parseWatchbaseCursor(later.cursor)).toEqual({ synced: [[901, "2026-11-12"], [902, "2026-11-12"]], pass: null });
    // The day after, the window moves on a day.
    const next = await runSync({ connector: connector(mock, { now: () => new Date("2026-11-13T08:00:00.000Z") }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(next.ingested).toBe(0);
    expect(paths(mock).filter((p) => p.includes("updated-since=2026-11-11"))).toHaveLength(2);
  });

  it("reads a brand added later in full, and drops brands no longer followed", async () => {
    const mock = watchbaseDocMock(store());
    const batches = await sync(connector(mock, { brands: "901, Testmaker 2" }), { synced: [[901, "2026-11-01"], [903, "2026-11-01"]], pass: null });
    expect(paths(mock)).toEqual(["/v1/brands?format=json", "/v1/watches?brand-id=901&updated-since=2026-10-31&format=json", "/v1/watches?brand-id=902&format=json", "/v1/watch?id=6001&format=json", "/v1/watch?id=6002&format=json", "/v1/watch?id=6003&format=json"]);
    expect(batches.map((b) => b.events.length)).toEqual([0, 3]);
    expect(parseWatchbaseCursor(batches.at(-1)!.cursor)).toEqual({ synced: [[901, TODAY], [902, TODAY]], pass: null });
  });

  it("asks for the brand list only when a brand is named, and reads each brand once", async () => {
    const mock = watchbaseDocMock(store());
    await sync(connector(mock, { brands: "902, 902" }));
    expect(paths(mock)[0]).toBe("/v1/watches?brand-id=902&format=json");
    expect(paths(mock).filter((p) => p.startsWith("/v1/brands"))).toEqual([]);
    const both = watchbaseDocMock(store({ brands: [{ id: 902, name: "Testmaker 2" }, { id: 903, name: "testmaker 2" }, { id: "x", name: "Broken" } as never, null as never, { id: 904, name: "" }] }));
    await sync(connector(both, { brands: "TESTMAKER 2, 902" }));
    expect(paths(both).filter((p) => p.startsWith("/v1/watches"))).toEqual(["/v1/watches?brand-id=902&format=json"]);
    for (const brands of ["Broken", "Nobody"]) expect(await failure(sync(connector(both, { brands })))).toEqual(new WatchbaseConfigError(`WATCHBASE_BRANDS names a brand WatchBase doesn't list: ${brands}`));
    // A brand named and given by id, in either order, is read once and kept once in the checkpoint.
    for (const brands of ["TESTMAKER 2, 902", "902, Testmaker 2"]) {
      const once = watchbaseDocMock(store());
      const batches = await sync(connector(once, { brands }));
      expect(paths(once).filter((p) => p.startsWith("/v1/watches")), brands).toEqual(["/v1/watches?brand-id=902&format=json"]);
      expect(parseWatchbaseCursor(batches.at(-1)!.cursor), brands).toEqual({ synced: [[902, TODAY]], pass: null });
    }
  });

  it("matches a brand name in full, and skips list entries whose id doesn't read", async () => {
    const x80 = "x".repeat(80);
    const brands = [
      { id: 911, name: "x".repeat(81) },
      { id: 912, name: x80 },
      { id: "x", name: "Dup" } as never,
      { id: 913, name: "Dup" },
    ];
    const mock = watchbaseDocMock(store({ brands }));
    await sync(connector(mock, { brands: `${x80}, Dup` }));
    expect(paths(mock).filter((p) => p.startsWith("/v1/watches"))).toEqual(["/v1/watches?brand-id=912&format=json", "/v1/watches?brand-id=913&format=json"]);
    const longer = watchbaseDocMock(store({ brands: [{ id: 911, name: "x".repeat(81) }] }));
    expect(await failure(sync(connector(longer, { brands: x80 })))).toEqual(new WatchbaseConfigError(`WATCHBASE_BRANDS names a brand WatchBase doesn't list: ${x80}`));
  });

  it("reads at most WATCHBASE_MAX_WATCHES a sync, and the next sync goes on from there", async () => {
    const mock = watchbaseDocMock(store());
    const { memory, pipeline } = testPipeline();
    const run = () => runSync({ connector: connector(mock, { maxWatches: 10 }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    const first = await run();
    expect(first).toMatchObject({ ingested: 10, batches: 1 });
    expect(mock.creditsUsed).toBe(10 * WATCHBASE_CREDITS_PER_WATCH);
    expect(parseWatchbaseCursor(first.cursor)!.pass).toEqual({ started: TODAY, brand: 901, after: 5010 });
    const counts = [first.ingested];
    for (let i = 0; i < 3; i++) counts.push((await run()).ingested);
    expect(counts).toEqual([10, 10, 10, 3]);
    expect(mock.creditsUsed).toBe(33 * WATCHBASE_CREDITS_PER_WATCH);
    expect(memory.events).toHaveLength(33);
    // The third sync spent its last read finishing brand 901 and stopped before listing brand 902.
    expect(paths(mock).filter((p) => p.startsWith("/v1/watches?brand-id=902"))).toHaveLength(1);
    const exact = await sync(connector(watchbaseDocMock(store()), { maxWatches: 30 }));
    expect(exact.map((b) => b.events.length)).toEqual([25, 5]);
    expect(parseWatchbaseCursor(exact.at(-1)!.cursor)!.pass).toEqual({ started: TODAY, brand: null, after: 0 });
    expect((await sync(connector(watchbaseDocMock(store()), { maxWatches: 31 }))).map((b) => b.events.length)).toEqual([25, 5, 1]);
    expect((await sync(connector(watchbaseDocMock(store()), { maxWatches: 24 }))).map((b) => b.events.length)).toEqual([24]);
    expect((await sync(connector(watchbaseDocMock(store()))))).toHaveLength(3);
    expect(WATCHBASE_DEFAULT_MAX_WATCHES).toBe(200);
    // Unset, the cap is 200 watches.
    watchbaseWatch.reset();
    const big = await sync(connector(watchbaseDocMock({ apiKey: KEY, watches: watchbaseWatch.many(201) }), { brands: "901" }));
    expect(eventsOf(big)).toHaveLength(200);
    expect(parseWatchbaseCursor(big.at(-1)!.cursor)!.pass).toEqual({ started: TODAY, brand: 901, after: 5200 });
    // 26 watches: the first batch leaves one, so the brand is still open.
    watchbaseWatch.reset();
    const odd = await sync(connector(watchbaseDocMock({ apiKey: KEY, watches: watchbaseWatch.many(26) }), { brands: "901" }));
    expect(odd.map((b) => [b.events.length, parseWatchbaseCursor(b.cursor)!.pass])).toEqual([
      [25, { started: TODAY, brand: 901, after: 5025 }],
      [1, null],
    ]);
  });

  it("closes a pass with nothing left to read, and goes on past a brand no longer followed", async () => {
    // A pass open on today with every brand read has nothing left: it closes without reading a watch.
    const today = watchbaseDocMock(store());
    const closing = await sync(connector(today, { brands: "902" }), { synced: [[902, TODAY]], pass: { started: TODAY, brand: null, after: 0 } });
    expect(closing).toEqual([{ events: [], cursor: JSON.stringify({ synced: [[902, TODAY]], pass: null }) }]);
    expect(today.reads).toEqual([]);
    // A pass that stopped in a brand no longer followed reads the rest, and closes.
    const dropped = watchbaseDocMock(store());
    const gone = await sync(connector(dropped, { brands: "902" }), { synced: [], pass: { started: "2026-11-10", brand: 905, after: 3 } });
    expect(paths(dropped)).toEqual(["/v1/watches?brand-id=902&format=json", "/v1/watch?id=6001&format=json", "/v1/watch?id=6002&format=json", "/v1/watch?id=6003&format=json"]);
    expect(gone.at(-1)!.cursor).toBe(JSON.stringify({ synced: [[902, "2026-11-10"]], pass: null }));
    // A pass that stopped in a brand goes on after its last id, with the brand's own window.
    const window = watchbaseDocMock(store());
    await sync(connector(window, { brands: "902" }), { synced: [[902, "2026-01-05"]], pass: { started: "2026-11-10", brand: 902, after: 6001 } });
    expect(paths(window)).toEqual(["/v1/watches?brand-id=902&updated-since=2026-01-04&format=json", "/v1/watch?id=6002&format=json", "/v1/watch?id=6003&format=json"]);
    // A pass that stopped in a brand no longer followed, with every brand left read that day, closes without reading.
    const done = watchbaseDocMock(store());
    const closed = await sync(connector(done, { brands: "902" }), { synced: [[902, "2026-11-10"]], pass: { started: "2026-11-10", brand: 905, after: 3 } });
    expect(closed).toEqual([{ events: [], cursor: JSON.stringify({ synced: [[902, "2026-11-10"]], pass: null }) }]);
    expect(done.reads).toEqual([]);
    // A pass that stopped in a later brand reads a brand listed before it from the start; finishing that brand
    // ends the place it had, so the later brand is read in full again (its repeats are duplicates).
    const order = watchbaseDocMock(store());
    await sync(connector(order, { brands: "901, 902" }), { synced: [], pass: { started: TODAY, brand: 902, after: 6002 } });
    expect(paths(order).filter((p) => p.startsWith("/v1/watch?"))).toEqual([...Array.from({ length: 30 }, (_, i) => `/v1/watch?id=${5001 + i}&format=json`), ...[6001, 6002, 6003].map((id) => `/v1/watch?id=${id}&format=json`)]);
    // A checkpoint that marks a brand read on the pass's day but stopped inside it goes on inside it, and stays open until it is done.
    const inside = { synced: [[902, "2026-01-05"]], pass: { started: "2026-01-05", brand: 902, after: 6001 } } satisfies WatchbaseCursor;
    const one = await sync(connector(watchbaseDocMock(store()), { brands: "902", maxWatches: 1 }), inside);
    expect(eventsOf(one).map((e) => e.payload.watchId)).toEqual(["watchbase:watch:6002"]);
    expect(parseWatchbaseCursor(one.at(-1)!.cursor)).toEqual({ synced: [[902, "2026-01-05"]], pass: { started: "2026-01-05", brand: 902, after: 6002 } });
    const rest = await sync(connector(watchbaseDocMock(store()), { brands: "902" }), inside);
    expect(eventsOf(rest).map((e) => e.payload.watchId)).toEqual(["watchbase:watch:6002", "watchbase:watch:6003"]);
    expect(parseWatchbaseCursor(rest.at(-1)!.cursor)).toEqual({ synced: [[902, "2026-01-05"]], pass: null });
    // A brand read on an earlier day keeps the pass open until it is read again.
    const twoQuiet = await sync(connector(watchbaseDocMock(store()), { brands: "901, 902" }), { synced: [[901, "2026-11-01"], [902, "2026-11-01"]], pass: null });
    expect(twoQuiet.map((b) => parseWatchbaseCursor(b.cursor))).toEqual([
      { synced: [[901, TODAY], [902, "2026-11-01"]], pass: { started: TODAY, brand: null, after: 0 } },
      { synced: [[901, TODAY], [902, TODAY]], pass: null },
    ]);
    // The window starts the day before, across a month and a year.
    for (const [day, before] of [["2026-03-01", "2026-02-28"], ["2027-01-01", "2026-12-31"]]) {
      const edge = watchbaseDocMock(store());
      await sync(connector(edge, { brands: "902" }), { synced: [[902, day!]], pass: null });
      expect(paths(edge)[0]).toBe(`/v1/watches?brand-id=902&updated-since=${before}&format=json`);
    }
    // A brand with nothing changed still gets the day it was read.
    const quiet = watchbaseDocMock(store());
    const none = await sync(connector(quiet, { brands: "902" }), { synced: [[902, "2026-11-01"]], pass: null });
    expect(none).toEqual([{ events: [], cursor: JSON.stringify({ synced: [[902, TODAY]], pass: null }) }]);
  });

  it("dead-letters listed watches and watches that don't read, once, and skips repeats", async () => {
    watchbaseWatch.reset();
    const watches = watchbaseWatch.many(27);
    const broken = { ...watches[1]!, reference_number: "" };
    const scriptedClient = {
      brands: async () => [],
      watches: async (brand: number) => (brand === 901 ? [{ refnr: "no id" }, ...watches.map((w) => ({ id: String((w.wb as { id: number }).id) })), { id: 5001 }, null] : []),
      watch: async (id: number) => (id === 5002 ? broken : watches.find((w) => (w.wb as { id: number }).id === id)!),
    };
    const c = watchbaseConnector({ apiKey: KEY, brands: "901", now: NOW, client: scriptedClient });
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 26, deadLettered: 3, batches: 2 });
    const batches = await sync(c);
    expect(batches.map((b) => b.events.length)).toEqual([27, 2]);
    expect((batches[0]!.events as WatchbaseEvent[]).slice(0, 2).map((e) => e.payload.problems)).toEqual([["a watch listed for BrandID 901 has no id"], ["a watch listed for BrandID 901 has no id"]]);
    const resumed = await sync(c, batches[0]!.cursor);
    expect(eventsOf(resumed).map((e) => e.payload.watchId)).toEqual(["watchbase:watch:5026", "watchbase:watch:5027"]);
    // Watches are read in id order, as numbers, and each is stamped when it was read.
    const asked: number[] = [];
    let tick = 0;
    const clock = () => new Date(Date.parse("2026-11-11T15:30:00.000Z") + 1000 * tick++);
    const watchOf = (id: number) => ({ wb: { id, modified: "2026-05-05" }, reference_number: `R${id}`, brand: { id: 901, name: "B" } });
    const ordered = watchbaseConnector({ apiKey: KEY, brands: "901", now: clock, client: { brands: async () => [], watches: async () => [{ id: 100 }, { id: 9 }, { id: 10 }], watch: async (id) => (asked.push(id), watchOf(id)) } });
    const read = eventsOf(await sync(ordered));
    expect(asked).toEqual([9, 10, 100]);
    expect(new Set(read.map((e) => e.receivedAt)).size).toBe(3);
    // A brand whose list holds only entries without ids gives them, and is read.
    const onlyBad = watchbaseConnector({ apiKey: KEY, brands: "901", now: NOW, client: { ...scriptedClient, watches: async () => [{ refnr: "x" }] } });
    const lone = await sync(onlyBad);
    expect(lone.map((b) => b.events.length)).toEqual([1]);
    expect(parseWatchbaseCursor(lone[0]!.cursor)).toEqual({ synced: [[901, TODAY]], pass: null });
  });

  it("stops with the key's message when WatchBase turns it down, never showing the key, and waits out a rate limit", async () => {
    const wrong = watchbaseDocMock(store({ apiKey: ["other", "k".repeat(24)].join("") }));
    const { memory, pipeline } = testPipeline();
    const error = await failure(runSync({ connector: connector(wrong), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, sleep: noSleep }));
    expect(error).toEqual(new WatchbaseConfigError(`WatchBase turned down the API key (HTTP 401): Invalid API key; ${KEY_MESSAGE}`));
    expect(`${error?.message}${error?.stack}`).not.toContain(KEY);
    const limited = watchbaseDocMock(store({ rateLimits: 2 }));
    const slept: number[] = [];
    const b = testPipeline();
    const report = await runSync({ connector: connector(limited, { sleep: async (ms) => void slept.push(ms), brands: "902" }), mode: "incremental", pipeline: b.pipeline, memory: b.memory, organizationId: TEST_ORG });
    expect(report.ingested).toBe(3);
    expect(slept).toEqual([1000, 2000]);
  });

  it("has nothing to write, and turns down any write", async () => {
    const c = connector(watchbaseDocMock(store()));
    expect(c.source).toBe("watchbase_datafeed");
    expect(c.writes).toBe(WATCHBASE_WRITES);
    expect(WATCHBASE_WRITES).toEqual([]);
    const audit = new InMemoryWriteAuditLog();
    const gate = new WriteGate({ organizationId: TEST_ORG, policy: READ_ONLY, audit });
    let performed = false;
    const anyWrite = { integration: "watchbase_datafeed", name: "edit_watch", description: "Not a WatchBase action", kind: "update", approval: "each", dailyCap: 1 } as const;
    await expect(gate.run(anyWrite, "watchbase-test", async () => void (performed = true))).rejects.toBeInstanceOf(WritesDisabledError);
    expect(performed).toBe(false);
    expect(audit.entries.map((e) => e.outcome)).not.toContain("performed");
  });
});

describe("WatchBase doc mock", () => {
  const get = (mock: WatchbaseMock, path: string, key: string | null = KEY, format: string | null = "json") => {
    const url = new URL(`${WATCHBASE_API_BASE}${path}`);
    if (format !== null) url.searchParams.set("format", format);
    if (key !== null) url.searchParams.set("key", key);
    return mock.fetch(url.toString());
  };

  it("names the manual's pages it was built from", () => {
    const module = DOC_MOCK_MODULES.find((m) => m.integration === "watchbase_datafeed")!;
    expect(module.watchPages).toEqual([WATCHBASE_DOC_PAGES.entryPoints, WATCHBASE_DOC_PAGES.brands, WATCHBASE_DOC_PAGES.watches, WATCHBASE_DOC_PAGES.watch]);
    const [mock] = module.docMocks();
    expect(mock!.source).toMatchObject({ url: "https://watchbase.com/manuals/datafeed/1/en/topic/api-entry-points", version: "v1", retrievedOn: "2026-11-11" });
    expect(mock!.routes.map((r) => [r.method, r.path, r.documentedAt])).toEqual([
      ["GET", "/brands", "https://watchbase.com/manuals/datafeed/1/en/topic/brands"],
      ["GET", "/watches", "https://watchbase.com/manuals/datafeed/1/en/topic/watches"],
      ["GET", "/watch", "https://watchbase.com/manuals/datafeed/1/en/topic/watch"],
    ]);
    expect(mock!.assumptions.length).toBeGreaterThan(0);
    expect(watchbaseBrand(2)).toEqual({ id: 902, name: "Testmaker 2" });
  });

  it("wants the key and JSON, and turns down parameters it doesn't know", async () => {
    const mock = watchbaseDocMock(store());
    expect((await get(mock, "/brands", null)).status).toBe(401);
    expect(await (await get(mock, "/brands", "wrong")).json()).toEqual({ error: "Invalid API key" });
    expect((await get(watchbaseDocMock({ apiKey: "" }), "/brands", "")).status).toBe(401);
    expect(await (await get(mock, "/brands", KEY, null)).json()).toEqual({ error: "the mock answers only json" });
    expect(await (await get(mock, "/brands", KEY, "xml")).json()).toEqual({ error: "the mock answers only json" });
    expect(await (await get(mock, "/brands", KEY, "csv")).json()).toEqual({ error: "format must be xml or json" });
    expect(await (await get(mock, "/brands?page=2")).json()).toEqual({ error: "unknown parameter page" });
    expect(await (await get(mock, "/watch?id=5001&brand-id=901")).json()).toEqual({ error: "unknown parameter brand-id" });
    expect(await (await get(mock, "/brands")).json()).toEqual({ num_results: 2, brands: [watchbaseBrand(1), watchbaseBrand(2)] });
    expect(mock.reads).toEqual([{ path: "/v1/brands", query: { format: "json" } }]);
  });

  it("lists a brand's watches, by family and by updated-since, strictly after the day", async () => {
    const mock = watchbaseDocMock(store());
    const list = async (q: string) => (await (await get(mock, `/watches?${q}`)).json()) as { num_results: number; watches: { id: number; updated: string }[] };
    const all = await list("brand-id=902");
    expect(all.num_results).toBe(3);
    expect(all.watches[0]).toEqual({ id: 6001, refnr: "TM2-1", name: "Test Watch 1", brand: { id: 902, name: "Testmaker 2" }, family: { id: 7002, name: "None" }, thumb: "https://example.test/thumb.jpg", updated: "2026-02-02" });
    expect((await list("brand-id=901&updated-since=2026-01-29")).watches.map((w) => w.updated)).toEqual(["2026-01-30", "2026-01-31"]);
    expect((await list("brand-id=901&updated-since=2026-01-31")).watches).toEqual([]);
    expect((await list("brand-id=901&family-id=7001")).num_results).toBe(30);
    expect((await list("brand-id=901&family-id=7002")).num_results).toBe(0);
    expect((await list("brand-id=903")).watches).toEqual([]);
    for (const [q, error] of [
      ["", "brand-id is required"],
      ["brand-id=0", "brand-id is required"],
      ["brand-id=abc", "brand-id is required"],
      ["brand-id=901&family-id=x", "family-id is not valid"],
      ["brand-id=901&updated-since=2026-1-1", "updated-since must be yyyy-mm-dd"],
      ["brand-id=901&updated-since=2026-99-99", "updated-since must be yyyy-mm-dd"],
    ]) {
      const r = await get(mock, `/watches?${q}`);
      expect(r.status, q).toBe(400);
      expect(await r.json()).toEqual({ error });
    }
  });

  it("answers one watch, counting its credits, and 404 for one it doesn't know", async () => {
    const mock = watchbaseDocMock(store({ rateLimits: 1 }));
    expect((await get(mock, "/watch?id=5001")).status).toBe(429);
    const ok = (await (await get(mock, "/watch?id=5001")).json()) as { watch: { reference_number: string } };
    expect(ok.watch.reference_number).toBe("TM-1");
    expect(mock.creditsUsed).toBe(25);
    expect(await (await get(mock, "/watch?id=9999")).json()).toEqual({ error: "Watch not found" });
    expect((await get(mock, "/watch?id=9999")).status).toBe(404);
    for (const q of ["", "id=0", "id=x"]) expect(await (await get(mock, `/watch?${q}`)).json(), q).toEqual({ error: "id is required" });
    expect(mock.creditsUsed).toBe(25);
    expect(mock.reads).toEqual([{ path: "/v1/watch", query: { id: "5001", format: "json" } }]);
    expect(JSON.stringify(mock.reads)).not.toContain(KEY);
  });

  it("turns down requests the manual doesn't document", async () => {
    const mock = watchbaseDocMock(store());
    await expect(mock.fetch(`${WATCHBASE_API_BASE}/watch?id=1&key=${KEY}`, { method: "POST", body: "{}" })).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`${WATCHBASE_API_BASE}/families?brand-id=1&key=${KEY}`)).rejects.toThrow(UndocumentedRequestError);
    await expect(mock.fetch(`https://api.watchbase.com/v2/brands?key=${KEY}`)).rejects.toThrow(UndocumentedRequestError);
    expect(mock.fetch.calls).toEqual([]);
  });
});
