import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { IDEX_LAB_GROWN_HEADERS, IDEX_NATURAL_HEADERS, TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, idexCsv, idexDocMock, idexStone, testPipeline, type IdexMock, type IdexMockData, type IdexMockStone } from "@karatos/connector-testkit";
import {
  IDEX_EVENT_TYPES,
  IDEX_FEEDS,
  IDEX_MAX_BYTES,
  IDEX_WRITES,
  IdexApiError,
  IdexConfigError,
  IdexFeedError,
  idexAmount,
  idexCents,
  idexClient,
  idexConnector,
  idexFeeds,
  parseIdexCursor,
  type IdexEvent,
  type IdexFeed,
  type IdexOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-10-25T09:00:00Z");
const RECEIVED = "2026-10-25T09:00:00.000Z";
const KEY = "idexKeyTest01";
// Shaped like an IDEX API secret, assembled so no scanner mistakes it for a real one.
const SECRET = ["test", "idex", "0".repeat(24)].join("-");
const noSleep = async () => {};

idexStone.reset();
const STONES = idexStone.many(5);
/** The same stones under the lab-grown file's header names. */
const asLabGrown = (s: IdexMockStone): IdexMockStone => ({ ...s, "Item ID": s["Item ID #"]!, "Supplier Stock Ref": s["Supplier Stock Ref."]!, "Certificate URL": s["Certificate Path"]!, "Image URL": s["Image Path"]!, "Country Name": s.Country!, "State Name": s["State / Region"]!, Availability: s["Guaranteed Availability"]!, "Grading Lab": "IGI" });

const data = (extra: Partial<IdexMockData> = {}): IdexMockData => ({ apiKey: KEY, apiSecret: SECRET, feeds: { natural: STONES }, ...extra });

function connector(mock: IdexMock = idexDocMock(data()), extra: Partial<IdexOptions> = {}) {
  return idexConnector({ apiKey: KEY, apiSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: NOW, batchSize: 2, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as IdexEvent[]);
const client = (mock: IdexMock, extra = {}) => idexClient({ apiKey: KEY, apiSecret: SECRET, fetch: mock.fetch, sleep: noSleep, ...extra });
const answering = (status: number, text: string, headers: Record<string, string> = {}): typeof globalThis.fetch => async () => new Response(text, { status, headers });

describe("IDEX client", () => {
  it("asks each feed for its template unzipped, with the key and secret in the body only", async () => {
    const mock = idexDocMock(data({ feeds: { natural: STONES, lab_grown: STONES.map(asLabGrown) } }));
    const c = client(mock);
    expect(await c.file("natural")).toBe(idexCsv(IDEX_NATURAL_HEADERS, STONES));
    expect(await c.file("lab_grown")).toBe(idexCsv(IDEX_LAB_GROWN_HEADERS, STONES.map(asLabGrown)));
    expect(mock.operations).toEqual([
      { feed: "natural", parameters: { file_format: "csv", data_format: "format_20230628_extended", create_zip_file: false } },
      { feed: "lab_grown", parameters: { data_format: "format_lg_20221130", create_zip_file: false } },
    ]);
    expect(mock.fetch.calls).toEqual([
      { method: "POST", url: IDEX_FEEDS.natural.url },
      { method: "POST", url: IDEX_FEEDS.lab_grown.url },
    ]);
    expect(JSON.stringify(mock.fetch.calls)).not.toContain(SECRET);
  });

  it("turns IDEX's errors into ones that say what happened, never showing the secret", async () => {
    const wrong = await idexClient({ apiKey: KEY, apiSecret: "x".repeat(20), fetch: idexDocMock(data()).fetch }).file("natural").catch((e: unknown) => e);
    expect(wrong).toMatchObject({ name: "IdexApiError", status: 500, code: 32110, message: "IDEX answered HTTP 500 for the natural feed (code 32110): Invalid authentication details." });
    await expect(client(idexDocMock(data())).file("lab_grown")).rejects.toMatchObject({ code: 32140, message: expect.stringMatching(/not part of the subscription/) });
    // IDEX's description is passed on with the key and secret taken out.
    const echo = await client(idexDocMock(data()), { fetch: answering(500, JSON.stringify({ result_info: { response_code: 1, response_description: `bad secret ${SECRET} for ${KEY}` } })) }).file("natural").catch((e: Error) => e.message);
    expect(echo).toBe("IDEX answered HTTP 500 for the natural feed (code 1): bad secret [hidden] for [hidden]");
    await expect(client(idexDocMock(data()), { fetch: answering(403, "") }).file("natural")).rejects.toThrow(/IDEX turned down the API key and secret$/);
    await expect(client(idexDocMock(data()), { fetch: answering(200, JSON.stringify({ result_info: { response_code: 7 } })) }).file("natural")).rejects.toMatchObject({ status: 200, code: 7 });
    await expect(client(idexDocMock(data()), { fetch: answering(502, "Bad gateway") }).file("natural")).rejects.toThrow(/^IDEX answered HTTP 502 for the natural feed$/);
    await expect(client(idexDocMock(data()), { fetch: answering(200, "<html>sign in</html>") }).file("natural")).rejects.toThrow(/with a page, not a CSV file/);
    await expect(client(idexDocMock(data()), { fetch: answering(200, "PK\x03\x04zipped") }).file("natural")).rejects.toThrow(/with a zip file/);
    await expect(client(idexDocMock(data()), { fetch: answering(200, JSON.stringify(["a"])) }).file("natural")).resolves.toBe('["a"]');
  });

  it("turns down a file too large to hold, by its stated or actual size", async () => {
    await expect(client(idexDocMock(data()), { fetch: answering(200, "a", { "content-length": String(IDEX_MAX_BYTES + 1) }) }).file("natural")).rejects.toThrow(/larger than 200 MB/);
    const huge = { text: async () => "x".repeat(IDEX_MAX_BYTES + 1), status: 200, headers: new Headers() } as unknown as Response;
    await expect(client(idexDocMock(data()), { fetch: async () => huge }).file("natural")).rejects.toThrow(/narrow the feed's filters on IDEX/);
  });

  it("waits out a 429 as Retry-After says, capped, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    expect(await client(idexDocMock(data({ throttle: 2 })), { sleep }).file("natural")).toContain("Item ID #");
    expect(waits).toEqual([2000, 2000]);
    await expect(client(idexDocMock(data({ throttle: 9 })), { sleep, rateLimitRetries: 1 }).file("natural")).rejects.toMatchObject({ status: 429 });
    waits.length = 0;
    await expect(client(idexDocMock(data()), { sleep, rateLimitRetries: 2, fetch: answering(429, "", { "retry-after": "999" }) }).file("natural")).rejects.toThrow(IdexApiError);
    expect(waits).toEqual([60000, 60000]);
    waits.length = 0;
    await expect(client(idexDocMock(data()), { sleep, rateLimitRetries: 2, fetch: answering(429, "") }).file("natural")).rejects.toThrow(IdexApiError);
    expect(waits).toEqual([1000, 2000]);
  });

  it("checks its settings and the feed before sending anything", async () => {
    const mock = idexDocMock(data());
    expect(() => idexClient({ apiKey: "a b", apiSecret: SECRET })).toThrow(IdexConfigError);
    expect(() => idexClient({ apiKey: KEY, apiSecret: "short" })).toThrow(/IDEX_API_SECRET/);
    await expect(client(mock).file("colored" as IdexFeed)).rejects.toThrow(/not an IDEX Onsite feed: "colored"/);
    expect(mock.operations).toEqual([]);
  });
});

describe("IDEX feed reading", () => {
  it("reads amounts and rounds dollars to cents, returning null rather than guessing", () => {
    expect([idexAmount("1.01"), idexAmount(" 4,250.00 "), idexAmount("0"), idexAmount("-1"), idexAmount("POA"), idexAmount(undefined)]).toEqual([1.01, 4250, null, null, null, null]);
    expect([idexCents(4010), idexCents(4050.105), idexCents(1.005), idexCents(0.5)]).toEqual([401000, 405011, 101, 50]);
  });

  it("reads which feeds to sync from IDEX_FEEDS", () => {
    expect(idexFeeds(undefined)).toEqual(["natural"]);
    expect(idexFeeds(" ")).toEqual(["natural"]);
    expect(idexFeeds("Lab Grown, natural,lab_grown")).toEqual(["lab_grown", "natural"]);
    expect(() => idexFeeds("natural,colored")).toThrow(/IDEX_FEEDS must be/);
  });
});

describe("IDEX connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data({ feeds: { natural: STONES, lab_grown: STONES.map(asLabGrown) } }));
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 5 } });
    expect(result.full.batches).toBe(3);
    expect(Object.keys(parseIdexCursor(result.full.cursor!)!.natural!)).toEqual(STONES.map((s) => s["Item ID #"]));
  });

  it("records each stone's grades, measurements and asking price, but not its media links", async () => {
    const [first] = await eventsOf();
    expect(first).toEqual({
      id: expect.stringMatching(/^idex_listed:natural:900001:[0-9a-f]{12}$/),
      type: IDEX_EVENT_TYPES.listed,
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^idex:listed:natural:900001:[0-9a-f]{12}$/),
      payload: {
        source: "IDEX",
        feed: "natural",
        labGrown: false,
        itemId: "900001",
        supplierStockRef: "TEST-1",
        shape: "Round",
        carat: 1.01,
        color: "G",
        fancyColor: undefined,
        treatedColor: undefined,
        clarity: "VS1",
        cutGrade: "Excellent",
        polish: "Excellent",
        symmetry: "Very Good",
        lab: "GIA",
        certificateNumber: "TESTCERT1",
        pricePerCaratCents: 401000,
        totalPriceCents: 405010,
        currency: "USD",
        percentOffIdexList: -12.5,
        measurements: { length: 6.42, width: 6.45, height: 3.98 },
        proportions: { depthPct: 61.8, tablePct: 57, crownHeight: null, crownAngle: null, pavilionDepth: null, pavilionAngle: null, girdle: "Medium to Slightly Thick", culet: "None" },
        fluorescence: "Faint Blue",
        graining: undefined,
        enhancement: undefined,
        shade: undefined,
        milky: undefined,
        blackInclusion: undefined,
        eyeClean: "Yes",
        brand: undefined,
        provenance: undefined,
        availability: "Yes",
        pairStockRef: undefined,
        location: "New York, USA",
        media: { certificateFile: true, image: true, video: false, view3d: false },
      },
    });
    expect(JSON.stringify(first)).not.toContain("https://");
  });

  it("reads the lab-grown file's own column names, and fancy colors and provenance when given", async () => {
    const fancy = { ...STONES[0]!, "Natural Fancy Color": "Yellow", "Natural Fancy Color Intensity": "Fancy Intense", "Provenance Number": "PN-1", "Video URL": "https://example.test/v.mp4", Depth: "1e3", "Crown Angle": "0" };
    const mock = idexDocMock(data({ feeds: { natural: [fancy], lab_grown: STONES.slice(0, 1).map(asLabGrown) } }));
    const events = await eventsOf(connector(mock, { feeds: ["natural", "lab_grown"] }));
    expect(events.map((e) => [e.payload.feed, e.payload.labGrown, e.payload.itemId])).toEqual([
      ["natural", false, "900001"],
      ["lab_grown", true, "900001"],
    ]);
    expect(events[0]!.payload).toMatchObject({ fancyColor: { color: "Yellow", intensity: "Fancy Intense", overtone: undefined }, provenance: { report: undefined, number: "PN-1" }, media: { video: true }, proportions: { depthPct: null, crownAngle: 0 } });
    expect(events[1]!.payload).toMatchObject({ lab: "IGI", supplierStockRef: "TEST-1", location: "New York, USA", availability: "Yes", media: { certificateFile: true, image: true } });
    expect(events[1]!.idempotencyKey).toMatch(/^idex:listed:lab_grown:900001:/);
  });

  it("records only what changed on the next sync: repriced stones, new ones and ones that left", async () => {
    const feeds: IdexMockData["feeds"] = { natural: STONES };
    const mock = idexDocMock(data({ feeds }));
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 5 });
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 0 });
    const [a, b, , d, e] = STONES as [IdexMockStone, IdexMockStone, IdexMockStone, IdexMockStone, IdexMockStone];
    const added = idexStone.one();
    feeds.natural = [a, { ...b, "Price Per Carat": "3900.00", "Total Price": "3939.00" }, d, e, added];
    expect(await sync()).toMatchObject({ ingested: 3 });
    const latest = memory.events.slice(5).map((x) => [x.type, x.payload.itemId]);
    expect(latest).toEqual([
      [IDEX_EVENT_TYPES.listed, "900002"],
      [IDEX_EVENT_TYPES.listed, added["Item ID #"]],
      [IDEX_EVENT_TYPES.delisted, "900003"],
    ]);
    // A stone that comes back unchanged, and leaves again, is recorded each time.
    feeds.natural = [a, { ...b, "Price Per Carat": "3900.00", "Total Price": "3939.00" }, STONES[2]!, d, e, added];
    expect(await sync()).toMatchObject({ ingested: 1 });
    feeds.natural = [a, { ...b, "Price Per Carat": "3900.00", "Total Price": "3939.00" }, d, e, added];
    expect(await sync()).toMatchObject({ ingested: 1 });
    const back = memory.events.filter((x) => x.payload.itemId === "900003").map((x) => x.idempotencyKey.replace(/[0-9a-f]{12}/, "#"));
    expect(back).toEqual(["idex:listed:natural:900003:#", "idex:delisted:natural:900003:1", "idex:listed:natural:900003:#:1", "idex:delisted:natural:900003:2"]);
    expect(parseIdexCursor(await memory.getCheckpoint(TEST_ORG, "idex", "incremental"))!.natural!["900003"]).toBe("~2");
    // While it stays away, nothing more is recorded.
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 0 });
    // Read again from scratch, as after a lost checkpoint: what is in the feed now is a duplicate.
    expect(await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 5 });
  });

  it("dead-letters rows that don't read and repeated item numbers, keeping the rest", async () => {
    const rows = [STONES[0]!, { ...STONES[1]!, "Item ID #": "" }, { ...STONES[2]!, Carat: "1,5ct", "Price Per Carat": "POA" }, { ...STONES[3]!, Cut: "", "Total Price": "" }, { ...STONES[0]!, "Price Per Carat": "1.00" }, { ...STONES[4]!, "Item ID #": "../900005" }];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(idexDocMock(data({ feeds: { natural: rows } }))), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 1, deadLettered: 5 });
    expect(memory.deadLetters.map((d) => (d.raw as { payload: { line: number; problems: string[] } }).payload)).toEqual([
      expect.objectContaining({ line: 3, problems: ["has no IDEX item number that reads"] }),
      expect.objectContaining({ line: 4, problems: ["has no carat weight that reads", "has no price per carat that reads"] }),
      expect.objectContaining({ line: 5, problems: ["has no total price that reads", "has no shape"] }),
      expect.objectContaining({ line: 6, problems: ["repeats item 900001"] }),
      expect.objectContaining({ line: 7, problems: ["has no IDEX item number that reads"] }),
    ]);
  });

  it("stops on a file that isn't the expected CSV, saying what is wrong", async () => {
    const sync = (natural: string) => collect(connector(idexDocMock(data({ feeds: { natural } }))).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    await expect(sync("Stock,Weight\r\nA1,1.0\r\n")).rejects.toThrow(/the IDEX natural feed has no column for Item ID # or Item ID, Cut, Carat, Price Per Carat, Total Price/);
    await expect(sync('Item ID #,Cut\r\n"900001,Round\r\n')).rejects.toBeInstanceOf(IdexFeedError);
    await expect(sync("Item ID #,Cut\r\n1,2,3\r\n")).rejects.toThrow(/isn't a CSV file that reads: CSV line 2/);
    // A byte-order mark is read past, as the CSV reader trims headers.
    expect(await eventsOf(connector(idexDocMock(data({ feeds: { natural: `\uFEFF${idexCsv(IDEX_NATURAL_HEADERS, STONES.slice(0, 1))}` } }))))).toHaveLength(1);
  });

  it("never marks the whole feed delisted on an empty file, and reads nothing from a first empty one", async () => {
    const feeds: IdexMockData["feeds"] = { natural: STONES };
    const mock = idexDocMock(data({ feeds }));
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    feeds.natural = [];
    await expect(runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/empty natural feed; nothing was marked delisted/);
    expect(memory.events.filter((e) => e.type === IDEX_EVENT_TYPES.delisted)).toEqual([]);
    expect(await eventsOf(connector(idexDocMock(data({ feeds: { natural: "" } }))))).toEqual([]);
  });

  it("stops on a feed larger than maxStones", async () => {
    await expect(eventsOf(connector(idexDocMock(data()), { maxStones: 4 }))).rejects.toThrow(/holds 5 stones, more than the 4 allowed; narrow its filters on IDEX or raise IDEX_MAX_STONES/);
    expect(() => connector(idexDocMock(data()), { maxStones: 0 })).toThrow(/maxStones must be a positive whole number/);
    expect(() => connector(idexDocMock(data()), { batchSize: 1.5 })).toThrow(/batchSize must be/);
    expect(() => connector(idexDocMock(data()), { feeds: [] })).toThrow(/feeds must be natural, lab_grown or both/);
  });

  it("runs the same way incrementally, takes no webhooks, and has every write turned down while writes are off", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("idex");
    expect(c.handleWebhook).toBeUndefined();
    expect(c.writes).toBe(IDEX_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["upload_listings", "refused"],
      ["request_stone", "refused"],
    ]);
    expect(idexConnector({ apiKey: KEY, apiSecret: SECRET }).source).toBe("idex");
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseIdexCursor(null)).toBeNull();
    const good = { natural: { "900001": "0123456789ab", "900002": "0123456789ab~2", "900003": "~1" } };
    expect(parseIdexCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of ["null", "[]", JSON.stringify({ colored: {} }), JSON.stringify({ natural: [] }), JSON.stringify({ natural: { "../x": "0123456789ab" } }), JSON.stringify({ natural: { "900001": "short" } }), JSON.stringify({ natural: { "900001": "~0" } }), JSON.stringify({ natural: { "900001": "" } }), JSON.stringify({ natural: { "900001": "0123456789ab~" } })]) {
      expect(() => parseIdexCursor(bad), bad).toThrow(/IDEX checkpoint is not in the expected shape/);
    }
  });
});
