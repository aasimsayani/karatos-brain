import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, nivodaDiamond, nivodaDocMock, testPipeline, type NivodaMock, type NivodaMockData, type NivodaMockDiamond } from "@karatos/connector-testkit";
import {
  NIVODA_ENDPOINTS,
  NIVODA_EVENT_TYPES,
  NIVODA_REQUEST_SPACING_MS,
  NIVODA_WRITES,
  NivodaApiError,
  NivodaAuthError,
  NivodaConfigError,
  NivodaSearchError,
  nivodaClient,
  nivodaConnector,
  nivodaEnvironment,
  nivodaQuery,
  parseNivodaCursor,
  readNivodaItem,
  type NivodaClientOptions,
  type NivodaEvent,
  type NivodaOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-10-28T09:00:00Z");
const RECEIVED = "2026-10-28T09:00:00.000Z";
const USERNAME = "buyer@example.test";
// Shaped like a Nivoda password, assembled so no scanner mistakes it for a real one.
const PASSWORD = ["test", "nivoda", "x".repeat(16)].join("-");
const noSleep = async () => {};

nivodaDiamond.reset();
const DIAMONDS = nivodaDiamond.many(5);
const data = (extra: Partial<NivodaMockData> = {}): NivodaMockData => ({ username: USERNAME, password: PASSWORD, diamonds: DIAMONDS, ...extra });

function connector(mock: NivodaMock = nivodaDocMock(data()), extra: Partial<NivodaOptions> = {}) {
  return nivodaConnector({ username: USERNAME, password: PASSWORD, fetch: mock.fetch, sleep: noSleep, now: NOW, batchSize: 2, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as NivodaEvent[]);
const client = (mock: NivodaMock, extra: Partial<NivodaClientOptions> = {}) => nivodaClient({ username: USERNAME, password: PASSWORD, fetch: mock.fetch, sleep: noSleep, ...extra });
const answering = (status: number, body: string, headers: Record<string, string> = {}): typeof globalThis.fetch => async () => new Response(body, { status, headers });
/** A clock that only moves when the client sleeps, or when a test moves it. */
function clock(start = Date.parse(RECEIVED)) {
  let t = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => new Date(t),
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const many = (count: number): NivodaMockDiamond[] => {
  nivodaDiamond.reset();
  const out = nivodaDiamond.many(count);
  nivodaDiamond.reset();
  nivodaDiamond.many(5);
  return out;
};

describe("Nivoda client", () => {
  it("signs in once, then searches as the token, cheapest first, 50 at a time, sending the password only to sign in", async () => {
    const mock = nivodaDocMock(data());
    const c = client(mock);
    const page = await c.search({ labgrown: false }, 0);
    expect(page).toEqual({ totalCount: 5, items: DIAMONDS });
    await c.search({ labgrown: false }, 50);
    expect(mock.operations).toEqual([
      { op: "sign_in", username: USERNAME },
      { op: "search", query: { labgrown: false }, offset: 0, limit: 50, order: "price ASC" },
      { op: "search", query: { labgrown: false }, offset: 50, limit: 50, order: "price ASC" },
    ]);
    expect(mock.fetch.calls).toEqual(Array(3).fill({ method: "POST", url: NIVODA_ENDPOINTS.production }));
    expect(JSON.stringify(mock.fetch.calls)).not.toContain(PASSWORD);
  });

  it("sends the password in the sign-in body only, and to staging when asked", async () => {
    const bodies: { url: string; body: string }[] = [];
    const mock = nivodaDocMock(data());
    const spy: typeof globalThis.fetch = async (input, init) => {
      bodies.push({ url: String(input), body: String(init?.body) });
      return mock.fetch(NIVODA_ENDPOINTS.production, init);
    };
    await client(mock, { fetch: spy, environment: "staging" }).search({}, 0);
    expect(bodies.map((b) => b.url)).toEqual([NIVODA_ENDPOINTS.staging, NIVODA_ENDPOINTS.staging]);
    expect(bodies[0]!.body).toContain(PASSWORD);
    expect(bodies[1]!.body).not.toContain(PASSWORD);
    expect(JSON.parse(bodies[1]!.body).variables).toEqual({ query: {}, offset: 0, limit: 50, token: expect.stringMatching(/^test-token-1-/) });
  });

  it("spaces every request at least 30 seconds after the one before", async () => {
    const time = clock();
    const c = client(nivodaDocMock(data()), { now: time.now, sleep: time.sleep });
    await c.search({}, 0);
    expect(time.waits).toEqual([NIVODA_REQUEST_SPACING_MS]);
    time.advance(12_000);
    await c.search({}, 50);
    expect(time.waits).toEqual([30_000, 18_000]);
    time.advance(45_000);
    await c.search({}, 100);
    expect(time.waits).toEqual([30_000, 18_000]);
  });

  it("takes a new token 10 minutes before the 6 hours run out, and once more when Nivoda turns one down", async () => {
    const time = clock();
    const mock = nivodaDocMock(data());
    const c = client(mock, { now: time.now, sleep: time.sleep });
    await c.search({}, 0);
    time.advance(5 * 3_600_000 + 49 * 60_000 - 30_000);
    await c.search({}, 0);
    expect(mock.operations.filter((o) => o.op === "sign_in")).toHaveLength(1);
    time.advance(60_000);
    await c.search({}, 0);
    expect(mock.operations.filter((o) => o.op === "sign_in")).toHaveLength(2);
    mock.expireTokens();
    expect(await c.diamond(DIAMONDS[1]!.id)).toEqual(DIAMONDS[1]);
    expect(mock.operations.slice(-3).map((o) => o.op)).toEqual(["diamond", "sign_in", "diamond"]);
    expect(await c.diamond("TESTOFFER404")).toBeNull();
  });

  it("gives up when a fresh token is turned down too", async () => {
    const mock = nivodaDocMock(data());
    let n = 0;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      const r = await mock.fetch(input, init);
      // Every token stops working as soon as it is issued.
      if (++n % 2 === 1) mock.expireTokens();
      return r;
    };
    const error = await client(mock, { fetch: flaky }).search({}, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NivodaAuthError);
    expect((error as Error).message).toBe("Nivoda turned down a new token for the diamond search (Token expired or invalid)");
    expect(mock.operations.map((o) => o.op)).toEqual(["sign_in", "search", "sign_in", "search"]);
  });

  it("turns Nivoda's errors into ones that say what happened, never showing the password", async () => {
    const wrong = await nivodaClient({ username: USERNAME, password: "y".repeat(12), fetch: nivodaDocMock(data()).fetch, sleep: noSleep }).search({}, 0).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ name: "NivodaAuthError", status: 200, message: "Nivoda turned down the sign-in (Unauthorized: the username or password is wrong): check NIVODA_USERNAME, NIVODA_PASSWORD and NIVODA_ENVIRONMENT" });
    const echo = JSON.stringify({ errors: [{ message: `bad password ${PASSWORD}` }, { message: 7 }, { message: "twice" }] });
    expect(await client(nivodaDocMock(data()), { fetch: answering(200, echo) }).search({}, 0).catch((e: Error) => e.message)).toBe("Nivoda turned down the sign-in (bad password [hidden]; twice): check NIVODA_USERNAME, NIVODA_PASSWORD and NIVODA_ENVIRONMENT");
    expect(await client(nivodaDocMock(data()), { fetch: answering(200, JSON.stringify({ data: { authenticate: { username_and_password: { token: "short" } } } })) }).search({}, 0).catch((e: Error) => e.message)).toBe("Nivoda turned down the sign-in: check NIVODA_USERNAME, NIVODA_PASSWORD and NIVODA_ENVIRONMENT");
    await expect(client(nivodaDocMock(data()), { fetch: answering(401, "") }).search({}, 0)).rejects.toMatchObject({ name: "NivodaAuthError", status: 401, message: "Nivoda turned down the request for sign-in: check NIVODA_USERNAME and NIVODA_PASSWORD" });
    await expect(client(nivodaDocMock(data()), { fetch: answering(403, "") }).search({}, 0)).rejects.toMatchObject({ name: "NivodaAuthError", status: 403 });
    await expect(client(nivodaDocMock(data()), { fetch: answering(502, "Bad gateway") }).search({}, 0)).rejects.toThrow(/^Nivoda answered HTTP 502 for sign-in$/);
    await expect(client(nivodaDocMock(data()), { fetch: answering(200, "<html>") }).search({}, 0)).rejects.toThrow(/sign-in with a body that isn't JSON/);
    await expect(client(nivodaDocMock(data()), { fetch: answering(200, "[1]") }).search({}, 0)).rejects.toThrow(/something other than a GraphQL answer/);
    await expect(client(nivodaDocMock(data()), { fetch: answering(200, "null") }).search({}, 0)).rejects.toThrow(/something other than a GraphQL answer/);
  });

  it("names a search error, a missing result and a page without its items or count", async () => {
    const mock = nivodaDocMock(data());
    const after = (body: unknown): typeof globalThis.fetch => {
      let n = 0;
      return async (input, init) => (n++ === 0 ? mock.fetch(input, init) : new Response(JSON.stringify(body), { status: 200 }));
    };
    const search = (body: unknown) => client(mock, { fetch: after(body) }).search({}, 0);
    await expect(search({ errors: [{ message: "Unknown field shapez" }] })).rejects.toMatchObject({ name: "NivodaApiError", message: "Nivoda answered the diamond search with an error: Unknown field shapez" });
    await expect(search({ data: { as: null } })).rejects.toThrow(/^Nivoda answered the diamond search without a result$/);
    await expect(search({ data: null })).rejects.toThrow(/without a result/);
    for (const page of [null, { items: [] }, { items: {}, total_count: 1 }, { items: [], total_count: -1 }, { items: [], total_count: 1.5 }, { items: [], total_count: "3" }]) {
      await expect(search({ data: { as: { diamonds_by_query: page } } }), JSON.stringify(page)).rejects.toThrow(/without its items and total count/);
    }
    await expect(client(mock, { fetch: after({ data: { as: {} } }) }).diamond("A1")).resolves.toBeNull();
  });

  it("waits out a 429 as Retry-After says, capped at two minutes, then gives up", async () => {
    const time = clock();
    const c = client(nivodaDocMock(data({ throttle: 2 })), { sleep: time.sleep, now: time.now });
    expect((await c.search({}, 0)).totalCount).toBe(5);
    expect(time.waits).toEqual([5000, 25_000, 5000, 25_000, 30_000]);
    await expect(client(nivodaDocMock(data({ throttle: 9 })), { rateLimitRetries: 1 }).search({}, 0)).rejects.toMatchObject({ name: "NivodaApiError", status: 429 });
    const capped = clock();
    await expect(client(nivodaDocMock(data()), { ...capped, rateLimitRetries: 2, fetch: answering(429, "", { "retry-after": "999" }) }).search({}, 0)).rejects.toThrow(/HTTP 429/);
    expect(capped.waits).toEqual([120_000, 120_000]);
    const plain = clock();
    await expect(client(nivodaDocMock(data()), { ...plain, rateLimitRetries: 1, fetch: answering(429, "", { "retry-after": "soon" }) }).search({}, 0)).rejects.toThrow(/HTTP 429/);
    expect(plain.waits).toEqual([30_000]);
  });

  it("checks its settings, offsets and ids before sending anything", async () => {
    const mock = nivodaDocMock(data());
    expect(() => nivodaClient({ username: "a b", password: PASSWORD })).toThrow(NivodaConfigError);
    expect(() => nivodaClient({ username: "ab", password: PASSWORD })).toThrow(/NIVODA_USERNAME/);
    expect(() => nivodaClient({ username: USERNAME, password: "short" })).toThrow(/NIVODA_PASSWORD is missing or not in the expected shape/);
    expect(() => nivodaClient({ username: USERNAME, password: "has a space" })).toThrow(/NIVODA_PASSWORD/);
    expect(() => nivodaClient({ username: USERNAME, password: PASSWORD, environment: "sandbox" as "staging" })).toThrow(/NIVODA_ENVIRONMENT must be production or staging/);
    expect(() => nivodaClient({ username: USERNAME, password: PASSWORD, environment: "toString" as "staging" })).toThrow(/NIVODA_ENVIRONMENT/);
    await expect(client(mock).search({}, -1)).rejects.toThrow(/offset must be a whole number/);
    await expect(client(mock).search({}, 1.5)).rejects.toThrow(NivodaConfigError);
    await expect(client(mock).diamond("../x")).rejects.toThrow(/not a Nivoda diamond id/);
    expect(mock.operations).toEqual([]);
  });
});

describe("Nivoda search reading", () => {
  it("reads settings for the environment and the saved search", () => {
    expect([nivodaEnvironment(undefined), nivodaEnvironment(" "), nivodaEnvironment(" Staging "), nivodaEnvironment("production")]).toEqual(["production", "production", "staging", "production"]);
    expect(() => nivodaEnvironment("constructor")).toThrow(/NIVODA_ENVIRONMENT must be production or staging/);
    expect(nivodaQuery(undefined)).toEqual({});
    expect(nivodaQuery("  ")).toEqual({});
    expect(nivodaQuery('{"labgrown":true,"shapes":["OVAL"]}')).toEqual({ labgrown: true, shapes: ["OVAL"] });
    for (const bad of ["[]", "null", "3", '"x"', "{nope"]) expect(() => nivodaQuery(bad), bad).toThrow(/NIVODA_QUERY must be a JSON object/);
  });

  it("reads carats written as text and lab-grown stones, and turns down prices that aren't whole cents", () => {
    const base = DIAMONDS[0]!;
    const lab = readNivodaItem({ ...base, diamond: { ...base.diamond, certificate: { ...base.diamond.certificate, carats: " 2.5 ", labgrown: true } } }, 1);
    expect(lab).toMatchObject({ kind: "stone", payload: { carat: 2.5, labGrown: true, pricePerCaratCents: 160_400 } });
    expect(readNivodaItem({ ...base, price: 4010.5 }, 3)).toMatchObject({ kind: "unreadable", position: 3, problems: ["has no price that reads"] });
    expect(readNivodaItem({ ...base, price: "401000" }, 1)).toMatchObject({ kind: "unreadable", problems: ["has no price that reads"] });
    expect(readNivodaItem({ ...base, price: 0 }, 1)).toMatchObject({ kind: "unreadable" });
    expect(readNivodaItem({ ...base, diamond: { ...base.diamond, certificate: { ...base.diamond.certificate, carats: 0 } } }, 1)).toMatchObject({ problems: ["has no carat weight that reads"] });
    expect(readNivodaItem(null, 9)).toMatchObject({ kind: "unreadable", position: 9, problems: ["has no Nivoda id that reads", "has no price that reads", "has no carat weight that reads", "has no shape"] });
    // Text is cut at 200 characters, so a runaway field can't swell the event.
    expect(readNivodaItem({ ...base, diamond: { ...base.diamond, mine_of_origin: "M".repeat(500) } }, 1)).toMatchObject({ payload: { mineOfOrigin: "M".repeat(200) } });
    // Grades that aren't text are left out rather than guessed at.
    expect(readNivodaItem({ ...base, discount: "n/a", diamond: { ...base.diamond, certificate: { ...base.diamond.certificate, color: 5, table: "57.5" } } }, 1)).toMatchObject({ payload: { color: undefined, discountPct: null, proportions: { tablePct: 57.5 } } });
  });
});

describe("Nivoda connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data({ diamonds: many(60) }));
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 5 } });
    expect(result.full.batches).toBe(3);
    expect(Object.keys(parseNivodaCursor(result.full.cursor!)!)).toEqual(DIAMONDS.map((d) => d.id));
  });

  it("records each diamond's grades, measurements and price, but not its media links", async () => {
    const [first] = await eventsOf();
    expect(first).toEqual({
      id: expect.stringMatching(/^nivoda_listed:TESTOFFER1:[0-9a-f]{12}$/),
      type: NIVODA_EVENT_TYPES.listed,
      occurredAt: RECEIVED,
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^nivoda:listed:TESTOFFER1:[0-9a-f]{12}$/),
      payload: {
        source: "Nivoda",
        nivodaId: "TESTOFFER1",
        diamondId: "TESTDIAMOND1",
        nivodaStockId: "NIV-TEST-1",
        supplierStockId: "SUP-TEST-1",
        labGrown: false,
        shape: "ROUND",
        carat: 1.01,
        color: "G",
        clarity: "VS1",
        cutGrade: "EX",
        polish: "EX",
        symmetry: "VG",
        lab: "GIA",
        certificateNumber: "TESTCERT1",
        totalPriceCents: 401_000,
        pricePerCaratCents: 397_030,
        currency: "USD",
        discountPct: -20.5,
        measurements: { length: 6.42, width: 6.45, height: 3.98 },
        proportions: { depthPct: 61.8, tablePct: 57, girdle: "MEDIUM" },
        fluorescence: "FAINT BLUE",
        brown: "NONE",
        green: "NONE",
        milky: "NONE",
        eyeClean: "YES",
        mineOfOrigin: undefined,
        availability: "AVAILABLE",
        media: { image: true, video: false },
      },
    });
    expect(JSON.stringify(first)).not.toContain("https://");
    expect(JSON.stringify(first)).not.toContain("example.test");
  });

  it("reads every page of a large search, 30 seconds apart, before comparing", async () => {
    const all = many(120);
    const mock = nivodaDocMock(data({ diamonds: all }));
    const time = clock();
    const events = await eventsOf(connector(mock, { sleep: time.sleep, now: time.now, batchSize: 500 }));
    expect(events.map((e) => e.payload.nivodaId)).toEqual(all.map((d) => d.id));
    expect(mock.operations.map((o) => (o.op === "search" ? o.offset : o.op))).toEqual(["sign_in", 0, 50, 100]);
    expect(time.waits).toEqual([30_000, 30_000, 30_000]);
  });

  it("records only what changed on the next sync: repriced diamonds, new ones and ones that left", async () => {
    let diamonds: NivodaMockDiamond[] = DIAMONDS;
    const mock = nivodaDocMock(data({ diamonds: (offset) => ({ items: diamonds.slice(offset, offset + 50), total: diamonds.length }) }));
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 5 });
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 0 });
    const [a, b, c, d, e] = DIAMONDS as [NivodaMockDiamond, NivodaMockDiamond, NivodaMockDiamond, NivodaMockDiamond, NivodaMockDiamond];
    const repriced = { ...b, price: 390_000 };
    const added = { ...a, id: "TESTOFFER99", diamond: { ...a.diamond, id: "TESTDIAMOND99" } };
    diamonds = [a, repriced, d, e, added];
    expect(await sync()).toMatchObject({ ingested: 3 });
    expect(memory.events.slice(5).map((x) => [x.type, x.payload.nivodaId])).toEqual([
      [NIVODA_EVENT_TYPES.listed, "TESTOFFER2"],
      [NIVODA_EVENT_TYPES.listed, "TESTOFFER99"],
      [NIVODA_EVENT_TYPES.delisted, "TESTOFFER3"],
    ]);
    // A diamond that comes back unchanged, and leaves again, is recorded each time.
    diamonds = [a, repriced, c, d, e, added];
    expect(await sync()).toMatchObject({ ingested: 1 });
    diamonds = [a, repriced, d, e, added];
    expect(await sync()).toMatchObject({ ingested: 1 });
    const back = memory.events.filter((x) => x.payload.nivodaId === "TESTOFFER3").map((x) => x.idempotencyKey.replace(/[0-9a-f]{12}/, "#"));
    expect(back).toEqual(["nivoda:listed:TESTOFFER3:#", "nivoda:delisted:TESTOFFER3:1", "nivoda:listed:TESTOFFER3:#:1", "nivoda:delisted:TESTOFFER3:2"]);
    expect(parseNivodaCursor(await memory.getCheckpoint(TEST_ORG, "nivoda", "incremental"))!.TESTOFFER3).toBe("~2");
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 0 });
    // Read again from scratch, as after a lost checkpoint: what is in the search now is a duplicate.
    expect(await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 5 });
  });

  it("dead-letters results that don't read, and keeps a diamond that arrives twice once", async () => {
    const [a, b, c, d] = DIAMONDS as [NivodaMockDiamond, NivodaMockDiamond, NivodaMockDiamond, NivodaMockDiamond];
    const items = [a, { ...b, id: "" }, { ...c, price: -1 }, { ...d, diamond: { ...d.diamond, certificate: { ...d.diamond.certificate, shape: " " } } }, { ...a, price: 100 }, "not a diamond"];
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(nivodaDocMock(data({ diamonds: () => ({ items, total: items.length }) }))), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 1, deadLettered: 4 });
    expect(memory.events.map((e) => e.payload.totalPriceCents)).toEqual([401_000]);
    expect(memory.deadLetters.map((x) => (x.raw as { payload: { position: number; problems: string[] } }).payload)).toEqual([
      expect.objectContaining({ position: 2, problems: ["has no Nivoda id that reads"] }),
      expect.objectContaining({ position: 3, problems: ["has no price that reads"] }),
      expect.objectContaining({ position: 4, problems: ["has no shape"] }),
      expect.objectContaining({ position: 6, problems: ["has no Nivoda id that reads", "has no price that reads", "has no carat weight that reads", "has no shape"] }),
    ]);
  });

  it("marks nothing delisted while the search changes under it, and catches up on the next full read", async () => {
    const all = many(60);
    let read: (offset: number) => { items: unknown[]; total: number } = (offset) => ({ items: all.slice(offset, offset + 50), total: 60 });
    const mock = nivodaDocMock(data({ diamonds: (offset) => read(offset) }));
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(mock, { batchSize: 500 }), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 60 });
    const delisted = () => memory.events.filter((e) => e.type === NIVODA_EVENT_TYPES.delisted).map((e) => e.payload.nivodaId);
    // A diamond sold between pages: the count drops and the second page shifts up by one, so the first one it should hold is never seen.
    const gone = all.filter((_, i) => i !== 10);
    read = (offset) => (offset === 0 ? { items: all.slice(0, 50), total: 60 } : { items: gone.slice(50, 99), total: 59 });
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(delisted()).toEqual([]);
    // Fewer arrive than Nivoda counted, with the count steady.
    read = (offset) => ({ items: gone.slice(offset, offset + 50), total: 60 });
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(delisted()).toEqual([]);
    // A page that comes back empty early ends the read, also without delisting.
    read = (offset) => (offset === 0 ? { items: gone.slice(0, 50), total: 120 } : { items: [], total: 120 });
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(mock.operations.filter((o) => o.op === "search").length).toBe(2 + 2 + 2 + 2);
    expect(delisted()).toEqual([]);
    read = (offset) => ({ items: gone.slice(offset, offset + 50), total: 59 });
    expect(await sync()).toMatchObject({ ingested: 1 });
    expect(delisted()).toEqual([all[10]!.id]);
  });

  it("never marks the whole search delisted when it comes back empty, and reads nothing from a first empty one", async () => {
    let diamonds: NivodaMockDiamond[] = DIAMONDS;
    const mock = nivodaDocMock(data({ diamonds: (offset) => ({ items: diamonds.slice(offset, offset + 50), total: diamonds.length }) }));
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    diamonds = [];
    await expect(runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/Nivoda found no diamonds for the search; nothing was marked delisted/);
    expect(memory.events.filter((e) => e.type === NIVODA_EVENT_TYPES.delisted)).toEqual([]);
    await expect(eventsOf(connector(mock), JSON.stringify({ TESTOFFER1: "~1" }))).resolves.toEqual([]);
    expect(await eventsOf(connector(nivodaDocMock(data({ diamonds: [] }))))).toEqual([]);
  });

  it("stops on a search larger than maxStones after the first page, and checks its options", async () => {
    const mock = nivodaDocMock(data());
    await expect(eventsOf(connector(mock, { maxStones: 4 }))).rejects.toThrow(NivodaSearchError);
    await expect(eventsOf(connector(mock, { maxStones: 4 }))).rejects.toThrow(/finds 5 diamonds, more than the 4 allowed; narrow NIVODA_QUERY or raise NIVODA_MAX_STONES/);
    expect(mock.operations.filter((o) => o.op === "search")).toHaveLength(2);
    expect(await eventsOf(connector(mock, { maxStones: 5 }))).toHaveLength(5);
    expect(() => connector(mock, { maxStones: 0 })).toThrow(/maxStones must be a whole number from 1 to 50,000/);
    expect(() => connector(mock, { maxStones: 50_001 })).toThrow(/maxStones/);
    expect(() => connector(mock, { batchSize: 1.5 })).toThrow(/batchSize must be/);
    expect(() => connector(mock, { maxStones: 50_000 })).not.toThrow();
  });

  it("stops a search over 1,000 diamonds unless maxStones allows more", async () => {
    const big = nivodaDocMock(data({ diamonds: (offset) => ({ items: offset < 1001 ? many(50) : [], total: 1001 }) }));
    await expect(eventsOf(connector(big))).rejects.toThrow(/finds 1001 diamonds, more than the 1000 allowed/);
    const fits = nivodaDocMock(data({ diamonds: (offset) => ({ items: offset < 1000 ? many(50).map((d) => ({ ...d, id: `${d.id}X${offset}` })) : [], total: 1000 }) }));
    expect(await eventsOf(connector(fits, { batchSize: 2000 }))).toHaveLength(1000);
  });

  it("sends the saved search to Nivoda as written", async () => {
    const mock = nivodaDocMock(data());
    await eventsOf(connector(mock, { query: { labgrown: true, shapes: ["OVAL"] } }));
    expect(mock.operations[1]).toEqual({ op: "search", query: { labgrown: true, shapes: ["OVAL"] }, offset: 0, limit: 50, order: "price ASC" });
    await eventsOf(connector(mock));
    expect(mock.operations.at(-1)).toMatchObject({ query: {} });
  });

  it("runs the same way incrementally, takes no webhooks, and has every write turned down while writes are off", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("nivoda");
    expect(c.handleWebhook).toBeUndefined();
    expect(c.writes).toBe(NIVODA_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["create_hold", "refused"],
      ["create_order", "refused"],
    ]);
    expect(nivodaConnector({ username: USERNAME, password: PASSWORD }).source).toBe("nivoda");
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseNivodaCursor(null)).toBeNull();
    const good = { TESTOFFER1: "0123456789ab", TESTOFFER2: "0123456789ab~2", TESTOFFER3: "~1" };
    expect(parseNivodaCursor(JSON.stringify(good))).toEqual(good);
    for (const bad of ["null", "[]", '"x"', JSON.stringify({ "../x": "0123456789ab" }), JSON.stringify({ A1: "short" }), JSON.stringify({ A1: "~0" }), JSON.stringify({ A1: "" }), JSON.stringify({ A1: "0123456789ab~" }), JSON.stringify({ A1: 5 })]) {
      expect(() => parseNivodaCursor(bad), bad).toThrow(/Nivoda checkpoint is not in the expected shape/);
    }
  });
});
