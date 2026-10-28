import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, rapaportRow, rapnetDocMock, testPipeline, type RapnetMock, type RapnetMockData, type RapnetMockRow } from "@karatos/connector-testkit";
import {
  RAPNET_API,
  RAPNET_EVENT_TYPES,
  RAPNET_TOKEN_URL,
  RAPNET_WRITES,
  RapnetApiError,
  RapnetAuthError,
  RapnetConfigError,
  changesEvent,
  listEvent,
  parseRapnetCursor,
  rapDate,
  rapNumber,
  rapnetClient,
  rapnetConnector,
  type RapnetEvent,
  type RapnetOptions,
  type RapnetShape,
} from "../src/index.js";

const NOW = () => new Date("2026-10-23T12:00:00Z");
const RECEIVED = "2026-10-23T12:00:00.000Z";
const ID = "kAratOStest01";
// Shaped like a Rapaport client secret, assembled so no scanner mistakes it for a real one.
const SECRET = ["test", "rapnet", "0".repeat(24)].join("-");
const noSleep = async () => {};

rapaportRow.reset();
const ROUND = rapaportRow.many(3);
const PEAR = [rapaportRow.one({ shape: "pear ", color: "g", clarity: "vs1", caratprice: 990, low_size: 0.5, high_size: 0.69 }), rapaportRow.one({ shape: "Pear", color: "D-F", clarity: "IF-VVS", low_size: "0.01", high_size: "0.03", date: "10/15/2026 00:00:00" })];
const ROUND_CHANGES = [{ ...ROUND[0], caratprice: "1050.0000", old_caratprice: "1000.0000", old_date: "2026-10-15" }, { ...ROUND[1], caratprice: "1000", old_caratprice: "1020.0000", old_date: "2026-10-15" }, { ...ROUND[2] }];

const data = (extra: Partial<RapnetMockData> = {}): RapnetMockData => ({ clientId: ID, clientSecret: SECRET, lists: { round: ROUND, pear: PEAR }, changes: { round: ROUND_CHANGES }, ...extra });

function connector(mock: RapnetMock = rapnetDocMock(data()), extra: Partial<RapnetOptions> = {}) {
  return rapnetConnector({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: NOW, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as RapnetEvent[]);
const client = (mock: RapnetMock, extra = {}) => rapnetClient({ clientId: ID, clientSecret: SECRET, fetch: mock.fetch, sleep: noSleep, now: NOW, ...extra });

describe("RapNet client", () => {
  it("signs in once with the client ID and secret, then reads the lists with the token", async () => {
    const mock = rapnetDocMock(data());
    const c = client(mock);
    expect(await c.list("Round")).toEqual(ROUND);
    expect(await c.changes("Pear")).toEqual([]);
    expect(mock.operations).toEqual(["token", "list:round", "changes:pear"]);
    expect(mock.fetch.calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `POST ${RAPNET_TOKEN_URL}`,
      `GET ${RAPNET_API}/pricelist/api/Prices/list?shape=Round&csvnormalized=true`,
      `GET ${RAPNET_API}/pricelist/api/Prices/changes?shape=pear`,
    ]);
    // The secret goes in the sign-in body only, never in a URL.
    expect(JSON.stringify(mock.fetch.calls)).not.toContain(SECRET);
  });

  it("renews the token before it expires, and once more when one is rejected early", async () => {
    let clock = NOW().getTime();
    const mock = rapnetDocMock(data({ expiresIn: 3600 }));
    const c = client(mock, { now: () => new Date(clock) });
    await c.list("Round");
    clock += 50 * 60 * 1000;
    await c.list("Round");
    clock += 6 * 60 * 1000;
    await c.list("Round");
    expect(mock.operations).toEqual(["token", "list:round", "list:round", "token", "list:round"]);
    mock.operations.length = 0;
    mock.expireTokens();
    expect(await c.list("Pear")).toEqual(PEAR);
    expect(mock.operations).toEqual(["list:pear", "token", "list:pear"]);
  });

  it("says when the client ID and secret are turned down, never showing the secret", async () => {
    const error = await client(rapnetDocMock(data({ clientSecret: "x".repeat(20) }))).list("Round").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RapnetAuthError);
    expect(error).toMatchObject({ status: 401, message: expect.stringMatching(/turned down the client ID and secret/) });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("stops after a second rejected token rather than signing in forever", async () => {
    const mock = rapnetDocMock(data());
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await mock.fetch(input, init);
      mock.expireTokens();
      return response;
    };
    await expect(rapnetClient({ clientId: ID, clientSecret: SECRET, fetch, sleep: noSleep }).list("Round")).rejects.toThrow(RapnetAuthError);
    expect(mock.operations).toEqual(["token", "list:round", "token", "list:round"]);
  });

  it("says when the subscription doesn't include the price list", async () => {
    await expect(client(rapnetDocMock(data({ noSubscription: true }))).list("Round")).rejects.toMatchObject({ name: "RapnetApiError", status: 403, message: expect.stringMatching(/subscription doesn't include the price list/) });
  });

  it("waits out a 429 as Retry-After says, capped, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    expect(await client(rapnetDocMock(data({ throttle: 2 })), { sleep }).list("Round")).toEqual(ROUND);
    expect(waits).toEqual([2000, 2000]);
    await expect(client(rapnetDocMock(data({ throttle: 9 })), { sleep, rateLimitRetries: 1 }).list("Round")).rejects.toMatchObject({ status: 429 });
    const long = (status: number, retryAfter?: string): typeof globalThis.fetch => async () => new Response("{}", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
    waits.length = 0;
    await expect(rapnetClient({ clientId: ID, clientSecret: SECRET, fetch: long(429, "3600"), sleep, rateLimitRetries: 2 }).list("Round")).rejects.toThrow(/token service answered HTTP 429/);
    expect(waits).toEqual([60000, 60000]);
    waits.length = 0;
    await expect(rapnetClient({ clientId: ID, clientSecret: SECRET, fetch: long(429), sleep, rateLimitRetries: 2 }).list("Round")).rejects.toThrow(RapnetApiError);
    expect(waits).toEqual([1000, 2000]);
  });

  it("checks its settings and the shape before sending anything, and reads odd answers as errors", async () => {
    const mock = rapnetDocMock(data());
    expect(() => rapnetClient({ clientId: "short", clientSecret: SECRET })).toThrow(RapnetConfigError);
    expect(() => rapnetClient({ clientId: ID, clientSecret: "short" })).toThrow(/RAPNET_CLIENT_SECRET/);
    await expect(client(mock).list("Oval" as RapnetShape)).rejects.toThrow(/not a Rapaport price list shape: "Oval"/);
    expect(mock.operations).toEqual([]);

    const answer = (token: unknown, list: unknown, status = 200): typeof globalThis.fetch => async (input) =>
      String(input).startsWith(RAPNET_TOKEN_URL) ? new Response(typeof token === "string" ? token : JSON.stringify(token), { status: 200 }) : new Response(typeof list === "string" ? list : JSON.stringify(list), { status });
    const run = (f: typeof globalThis.fetch) => rapnetClient({ clientId: ID, clientSecret: SECRET, fetch: f, sleep: noSleep }).list("Round");
    await expect(run(answer({ token_type: "Bearer" }, []))).rejects.toThrow(/answered without a token/);
    await expect(run(answer("not json", []))).rejects.toThrow(/sign-in with a body that isn't JSON/);
    await expect(run(answer({ access_token: "a-token-value" }, { rows: [] }))).rejects.toThrow(/something other than a list of rows/);
    await expect(run(answer({ access_token: "a-token-value" }, "<html>"))).rejects.toThrow(/Round price list with a body that isn't JSON/);
    await expect(run(answer({ access_token: "a-token-value" }, [], 500))).rejects.toMatchObject({ status: 500, message: expect.stringMatching(/HTTP 500 for the Round price list/) });
    // A token without a lifetime is used for an hour, renewed five minutes early.
    let clock = NOW().getTime();
    let signIns = 0;
    const counting: typeof globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(RAPNET_TOKEN_URL)) signIns++;
      return answer({ access_token: "a-token-value", expires_in: "soon" }, [{ shape: "Round" }])(input, init);
    };
    const hourly = rapnetClient({ clientId: ID, clientSecret: SECRET, fetch: counting, sleep: noSleep, now: () => new Date(clock) });
    expect(await hourly.list("Round")).toEqual([{ shape: "Round" }]);
    clock += 54 * 60 * 1000;
    await hourly.list("Round");
    expect(signIns).toBe(1);
    clock += 2 * 60 * 1000;
    await hourly.list("Round");
    expect(signIns).toBe(2);
    const failing: typeof globalThis.fetch = async () => new Response("", { status: 503 });
    await expect(run(failing)).rejects.toThrow(/token service answered HTTP 503/);
  });
});

describe("Rapaport list reading", () => {
  it("reads sizes, prices and dates, returning null rather than guessing", () => {
    expect([rapNumber("1370.0000"), rapNumber(860), rapNumber(" 0.18 "), rapNumber("0"), rapNumber("-5"), rapNumber("1e3"), rapNumber(null), rapNumber("")]).toEqual([1370, 860, 0.18, null, null, null, null, null]);
    expect([rapDate("09/15/2023 00:00:00"), rapDate("9/5/2023"), rapDate("2023-09-15"), rapDate("2023-09-15T00:00:00Z"), rapDate("02/30/2023 00:00:00"), rapDate("2023-13-01"), rapDate("Thursday"), rapDate(undefined)]).toEqual([
      "2023-09-15",
      "2023-09-05",
      "2023-09-15",
      "2023-09-15",
      null,
      null,
      null,
      null,
    ]);
  });

  it("names each cell that doesn't read, by row number, and dead-letters the list", () => {
    const rows = [ROUND[0], "junk", { ...ROUND[1], shape: "Pear" }, { ...ROUND[1], low_size: "2", high_size: "1" }, { ...ROUND[1], color: "blue" }, { ...ROUND[1], clarity: "AB" }, { ...ROUND[1], caratprice: "call" }, { ...ROUND[1], date: "soon" }, { ...ROUND[1], high_size: "120" }];
    const { event, date } = listEvent("Round", rows, RECEIVED);
    expect(date).toBeNull();
    expect(event.occurredAt).toBeUndefined();
    expect(event.payload).toMatchObject({ cellCount: 1, problemCount: 8 });
    expect(event.payload.problems).toEqual([
      "row 2: is not a row",
      "row 3: is for another shape",
      "row 4: has no carat range that reads",
      "row 5: has no color grade that reads",
      "row 6: has no clarity grade that reads",
      "row 7: has no price that reads",
      "row 8: has no date that reads",
      "row 9: has no carat range that reads",
    ]);
    expect(listEvent("Pear", [], RECEIVED).event.payload.problems).toEqual(["the list has no rows"]);
    const many = listEvent("Round", Array.from({ length: 60 }, () => "junk"), RECEIVED).event.payload;
    expect([(many.problems as string[]).length, many.problemCount]).toEqual([50, 60]);
  });

  it("reads old prices and dates on changed cells, and flags ones that don't read", () => {
    expect(changesEvent("Round", [], RECEIVED)).toBeNull();
    const bad = changesEvent("Round", [{ ...ROUND_CHANGES[0], old_caratprice: "n/a" }, { ...ROUND_CHANGES[1], old_date: "last week" }], RECEIVED)!;
    expect(bad.occurredAt).toBeUndefined();
    expect(bad.payload.problems).toEqual(["row 1: has an old price that doesn't read", "row 2: has an old date that doesn't read"]);
    const rises = changesEvent("Round", [ROUND_CHANGES[0], ROUND_CHANGES[0], ROUND_CHANGES[1]], RECEIVED)!;
    expect(rises.payload).toMatchObject({ changedCount: 3, raised: 2, lowered: 1 });
  });

  it("dates a list by its newest cell, wherever it falls", () => {
    const rows = [{ ...ROUND[0], date: "10/08/2026 00:00:00" }, { ...ROUND[1], date: "10/22/2026 00:00:00" }, { ...ROUND[2], date: "10/15/2026 00:00:00" }];
    expect(listEvent("Round", rows, RECEIVED)).toMatchObject({ date: "2026-10-22", event: { occurredAt: "2026-10-22T00:00:00.000Z" } });
  });
});

describe("RapNet connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data());
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 3 } });
    // Round's list and its changes, then Pear's list (nothing moved in it).
    expect(result.full.batches).toBe(2);
    expect(result.replay.duplicates).toBe(3);
    expect(Object.keys(parseRapnetCursor(result.full.cursor!)!)).toEqual(["Round", "Pear"]);
  });

  it("records each shape's list as one event with every cell, dated by its newest price", async () => {
    const [round, changes, pear] = await eventsOf();
    expect(round).toEqual({
      id: expect.stringMatching(/^rapnet_list:round:2026-10-22:[0-9a-f]{12}$/),
      type: RAPNET_EVENT_TYPES.list,
      occurredAt: "2026-10-22T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^rapnet:list:round:2026-10-22:[0-9a-f]{12}$/),
      payload: {
        source: "Rapaport",
        shape: "Round",
        priceDate: "2026-10-22",
        currency: "USD",
        unit: "per_carat",
        cellCount: 3,
        cells: [
          { fromCarat: 1, toCarat: 1.49, color: "E", clarity: "VVS1", perCaratUsd: 1010, pricedOn: "2026-10-22" },
          { fromCarat: 1, toCarat: 1.49, color: "F", clarity: "VVS2", perCaratUsd: 1020, pricedOn: "2026-10-22" },
          { fromCarat: 1, toCarat: 1.49, color: "G", clarity: "VS1", perCaratUsd: 1030, pricedOn: "2026-10-22" },
        ],
      },
    });
    expect(changes!.type).toBe(RAPNET_EVENT_TYPES.changes);
    // Rapaport's own inconsistent spacing and case are tidied, and small sizes keep their grouped grades.
    expect(pear!.payload).toMatchObject({
      shape: "Pear",
      priceDate: "2026-10-22",
      cells: [
        { fromCarat: 0.5, toCarat: 0.69, color: "G", clarity: "VS1", perCaratUsd: 990, pricedOn: "2026-10-22" },
        { fromCarat: 0.01, toCarat: 0.03, color: "D-F", clarity: "IF-VVS", pricedOn: "2026-10-15" },
      ],
    });
  });

  it("records the cells that moved with their old prices, and counts the rises and falls", async () => {
    const changes = (await eventsOf()).find((e) => e.type === RAPNET_EVENT_TYPES.changes)!;
    expect(changes.occurredAt).toBe("2026-10-22T00:00:00.000Z");
    expect(changes.idempotencyKey).toMatch(/^rapnet:changes:round:2026-10-22:[0-9a-f]{12}$/);
    expect(changes.payload).toMatchObject({ changedCount: 3, raised: 1, lowered: 1 });
    expect(changes.payload.cells).toEqual([
      expect.objectContaining({ color: "E", perCaratUsd: 1050, previousPerCaratUsd: 1000, previousDate: "2026-10-15" }),
      expect.objectContaining({ color: "F", perCaratUsd: 1000, previousPerCaratUsd: 1020, previousDate: "2026-10-15" }),
      expect.objectContaining({ color: "G", perCaratUsd: 1030, previousPerCaratUsd: null, previousDate: null }),
    ]);
  });

  it("reads each list once: a later sync of the same week only reads the two lists", async () => {
    const mock = rapnetDocMock(data());
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 3, deadLettered: 0 });
    mock.operations.length = 0;
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 0 });
    expect(mock.operations).toEqual(["token", "list:round", "list:pear"]);
  });

  it("stores next week's list as new, and a list read again from scratch as duplicates", async () => {
    const lists: RapnetMockData["lists"] = { round: ROUND, pear: PEAR };
    const changes: NonNullable<RapnetMockData["changes"]> = { round: ROUND_CHANGES };
    const mock = rapnetDocMock(data({ lists, changes }));
    const { memory, pipeline } = testPipeline();
    await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    lists.round = ROUND.map((r: RapnetMockRow) => ({ ...r, caratprice: "2000", date: "10/29/2026 00:00:00" }));
    changes.round = lists.round.map((r) => ({ ...r, old_caratprice: "1000", old_date: "2026-10-22" }));
    expect(await runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 2 });
    expect(memory.events.filter((e) => e.type === RAPNET_EVENT_TYPES.list).map((e) => [e.payload.shape, e.payload.priceDate])).toEqual([
      ["Round", "2026-10-22"],
      ["Pear", "2026-10-22"],
      ["Round", "2026-10-29"],
    ]);
    // As after a lost checkpoint: the same lists again are duplicates.
    expect(await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 3 });
  });

  it("dead-letters a list that doesn't read, keeping it, and skips its changes", async () => {
    const mock = rapnetDocMock(data({ lists: { round: [{ ...ROUND[0], caratprice: "POA" }], pear: PEAR } }));
    const { memory, pipeline } = testPipeline();
    expect(await runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, deadLettered: 1 });
    expect(memory.deadLetters.map((d) => d.issues.map((i) => i.path))).toEqual([["occurredAt"]]);
    expect(mock.operations).not.toContain("changes:round");
  });

  it("reads only the shapes it is given, and rejects ones Rapaport doesn't publish", async () => {
    const mock = rapnetDocMock(data());
    expect((await eventsOf(connector(mock, { shapes: ["Pear"] }))).map((e) => e.payload.shape)).toEqual(["Pear"]);
    expect(mock.operations).toEqual(["token", "list:pear", "changes:pear"]);
    expect(() => connector(mock, { shapes: [] })).toThrow(/shapes must be some of Round, Pear/);
    expect(() => connector(mock, { shapes: ["Oval" as RapnetShape] })).toThrow(/shapes must be some of/);
  });

  it("stops the sync on a subscription without the price list, saying so", async () => {
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(rapnetDocMock(data({ noSubscription: true }))), mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 1 })).rejects.toThrow(/subscription doesn't include the price list/);
    expect(memory.events).toEqual([]);
  });

  it("runs the same way incrementally, takes no webhooks, and has every write turned down while writes are off", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("rapnet");
    expect(c.handleWebhook).toBeUndefined();
    expect(c.writes).toBe(RAPNET_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["upload_listings", "refused"],
      ["contact_seller", "refused"],
    ]);
    expect(rapnetConnector({ clientId: ID, clientSecret: SECRET }).source).toBe("rapnet");
  });

  it("rejects a checkpoint it didn't write", () => {
    const key = "rapnet:list:round:2026-10-22:0123456789ab";
    expect(parseRapnetCursor(null)).toBeNull();
    expect(parseRapnetCursor(JSON.stringify({ Round: key }))).toEqual({ Round: key });
    expect(parseRapnetCursor("{}")).toEqual({});
    for (const bad of ["null", "[]", JSON.stringify({ Oval: key }), JSON.stringify({ Round: "rapnet:list:round:../x:0123456789ab" }), JSON.stringify({ Round: 5 })]) {
      expect(() => parseRapnetCursor(bad), bad).toThrow(/RapNet checkpoint is not in the expected shape/);
    }
  });
});
