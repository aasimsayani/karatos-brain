import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  CASTING_EVENT_TYPE,
  GENERIC_PIRO_PROFILE,
  GRAMS_PER_UNIT,
  JOB_EVENT_TYPE,
  PIRO_WRITES,
  PiroFileError,
  PiroProfileError,
  jobStatus,
  memoryFileSource,
  parsePiroCursor,
  parsePiroProfile,
  parseWeightGrams,
  piroConnector,
  piroFileKind,
  piroKarat,
  piroMetal,
  resolvePiroProfile,
  sha256,
  type PiroEvent,
  type PiroOptions,
} from "../src/index.js";

const NOW = () => new Date("2026-02-10T00:00:00Z");
const RECEIVED = "2026-02-10T00:00:00.000Z";
const EXPORTED = "2026-02-09T23:00:00.000Z";

/** A job report as a shop exports it each day. */
const JOBS = [
  "Job No,Status,Last Updated,Department,Style No,Order No,Metal,Karat,Qty,Start Date,Due Date,Completed Date,Est Weight (g),Actual Weight (g),Tree No",
  "TEST-J-1001,In Progress,01/20/2026,Polishing,TEST-STYLE-1,TEST-SO-1,14K Yellow Gold,14K,1,01/10/2026,01/30/2026,,5.200,,TEST-T-1",
  "TEST-J-1002,Completed,01/22/2026,Shipping,TEST-STYLE-2,TEST-SO-2,Platinum,,2,01/05/2026,01/25/2026,01/22/2026,12.000,12.450,TEST-T-2",
  "TEST-J-1003,On Hold,,Setting,TEST-STYLE-3,,Gold,18,1,01/12/2026,,,,,",
  "TEST-J-1004,Waiting on stones,01/25/2026,,,,,,,,,,,,",
  "TEST-J-1005,New,02/01/2026,,,,Gold/Silver,,,,,,,,",
  "TEST-J-1006,Open,02/02/2026,,,,,,two,,,,,,",
  ",Open,02/02/2026,,,,,,,,,,,,",
  ",,,,,,,,,,,,,,",
].join("\r\n");

const OLD_JOBS = "Job No,Status,Last Updated\nTEST-J-0001,Completed,01/02/2019";

/** Casting trees in pennyweight, with castings and scrap but no returned total on one. */
const CASTING = [
  "Tree No,Cast Date,Metal,Karat,Status,Issued Weight (dwt),Returned Weight (dwt),Castings Weight (dwt),Scrap Weight (dwt),Jobs",
  "TEST-T-1,01/15/2026,Gold,14K,Closed,100.00,98.50,60.00,38.50,TEST-J-1001; TEST-J-1007",
  "TEST-T-2,01/16/2026,Platinum,,Closed,40.00,,25.00,14.00,TEST-J-1002",
  "TEST-T-3,01/17/2026,Silver,,Open,50.00,,,,",
  "TEST-T-4,01/18/2026,Gold,14K,Closed,12 g,,,,",
  "TEST-T-5,02/30/2026,Gold,14K,Closed,10.00,,,,",
  "TEST-T-6,01/19/2026,Rhodium,,Closed,10.00,,,,",
].join("\n");

function connector(options: Partial<PiroOptions> = {}, files: Record<string, string> = {}) {
  const source = memoryFileSource({ "jobs-2026-02-09.csv": JOBS, "jobs-2019.csv": OLD_JOBS, "casting-trees-2026-01.csv": CASTING, "notes.txt": "x", ...files }, EXPORTED);
  return piroConnector({ source, now: NOW, batchSize: 3, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as PiroEvent[]);
const dwt = (n: number) => Math.round(n * GRAMS_PER_UNIT.dwt * 1000) / 1000;

describe("reading PIRO values", () => {
  it("reads weights in grams or pennyweight, and nothing labeled in another unit", () => {
    expect(parseWeightGrams("5.2", "grams")).toBe(5.2);
    expect(parseWeightGrams("1,000.5 g", "grams")).toBe(1000.5);
    expect(parseWeightGrams("10 dwt", "dwt")).toBe(15.552);
    expect(parseWeightGrams("1 ozt", "ozt")).toBe(31.103);
    for (const [text, unit] of [["12 g", "dwt"], ["10 dwt", "grams"], ["0", "grams"], ["-1", "grams"], ["abc", "grams"], ["", "grams"], [undefined, "grams"]] as const) {
      expect(parseWeightGrams(text, unit), String(text)).toBeNull();
    }
  });

  it("names the metal from words, alloys and stamps, and only one metal", () => {
    const cases: [string | undefined, string | null][] = [
      ["14K Yellow Gold", "gold"],
      ["18kt WG", "gold"],
      ["Gold", "gold"],
      ["Sterling", "silver"],
      ["925 Silver", "silver"],
      ["PT950", "platinum"],
      ["Platinum", "platinum"],
      ["Palladium", "palladium"],
      ["Gold/Silver", null],
      ["Rhodium", null],
      ["", null],
      [undefined, null],
    ];
    for (const [text, metal] of cases) expect(piroMetal(text), String(text)).toBe(metal);
  });

  it("reads karats from 1 to 24 only", () => {
    expect(piroKarat("14K")).toBe(14);
    expect(piroKarat("18 kt")).toBe(18);
    expect(piroKarat("10")).toBe(10);
    expect(piroKarat("24karat")).toBe(24);
    for (const text of ["0", "25", "14.5", "925", "fine", "", undefined]) expect(piroKarat(text), String(text)).toBeNull();
  });

  it("maps status labels to a status, the profile's own labels first", () => {
    const cases: [string, string][] = [
      ["In Progress", "in_progress"],
      ["WIP", "in_progress"],
      ["At bench", "in_progress"],
      ["Polishing", "in_progress"],
      ["Completed", "completed"],
      ["Shipped", "completed"],
      ["On Hold", "on_hold"],
      ["on-hold", "on_hold"],
      ["Waiting on stones", "on_hold"],
      ["Cancelled", "cancelled"],
      ["Canceled", "cancelled"],
      ["Open", "open"],
      ["New", "open"],
      ["Not started", "open"],
      ["Stone sourcing", "other"],
    ];
    for (const [label, status] of cases) expect(jobStatus(label, GENERIC_PIRO_PROFILE), label).toBe(status);
    const shop = parsePiroProfile({ ...GENERIC_PIRO_PROFILE, statuses: { "stone sourcing": "on_hold", "at bench": "open" } });
    expect(jobStatus("Stone  Sourcing", shop)).toBe("on_hold");
    expect(jobStatus("At Bench", shop)).toBe("open");
  });
});

describe("PIRO profiles", () => {
  const custom = { id: "test_shop", name: "Test shop", files: { jobs: "^wip" }, columns: { jobs: { jobId: "Bag", status: "State" } } };

  it("fills defaults and accepts a client's own profile", () => {
    expect(parsePiroProfile(custom)).toMatchObject({ delimiter: ",", dateOrder: "mdy", utcOffset: "Z", statuses: {} });
  });

  it("rejects a profile it couldn't read files with, saying where", () => {
    expect(() => parsePiroProfile({ ...custom, files: {} })).toThrow(new PiroProfileError("PIRO profile: files must name job reports, casting reports or both"));
    expect(() => parsePiroProfile({ ...custom, files: { jobs: "(" } })).toThrow("PIRO profile: files.jobs is not a valid pattern");
    expect(() => parsePiroProfile({ ...custom, files: { casting: "tree" } })).toThrow("PIRO profile: files.casting is set but columns.casting is not");
    expect(() => parsePiroProfile({ ...custom, files: { casting: "tree" }, columns: { casting: { treeId: "T", castDate: "D", metal: "M" } } })).toThrow("PIRO profile: columns.casting needs issuedGrams or issuedDwt");
    expect(() => parsePiroProfile({ ...custom, statuses: { "On Hold": "on_hold" } })).toThrow('status label "On Hold" must be lowercase and trimmed');
    expect(() => parsePiroProfile({ ...custom, statuses: { hold: "paused" } })).toThrow(/statuses\.hold/);
    expect(() => parsePiroProfile({ ...custom, columns: { jobs: { jobId: "Bag" } } })).toThrow(/columns\.jobs\.status/);
    expect(() => parsePiroProfile({ ...custom, id: "Bad" })).toThrow(/id:/);
  });

  it("resolves PIRO_MAPPING_PROFILE to the generic profile or a JSON file, without echoing it", async () => {
    expect(await resolvePiroProfile(undefined)).toBe(GENERIC_PIRO_PROFILE);
    expect(await resolvePiroProfile(" generic ")).toBe(GENERIC_PIRO_PROFILE);
    expect((await resolvePiroProfile("/instance/piro.json", async () => JSON.stringify(custom))).id).toBe("test_shop");
    await expect(resolvePiroProfile("/i.json", async () => "{ SECRET-LOOKING")).rejects.toThrow(/^PIRO_MAPPING_PROFILE: could not read a JSON profile \(SyntaxError\)$/);
    await expect(resolvePiroProfile("/i.json", async () => JSON.stringify({ id: "x" }))).rejects.toThrow(PiroProfileError);
    const dir = await mkdtemp(join(tmpdir(), "piro-profile-"));
    await writeFile(join(dir, "piro.json"), JSON.stringify(custom));
    expect((await resolvePiroProfile(join(dir, "piro.json"))).id).toBe("test_shop");
  });

  it("tells job reports from casting reports by file name, reading only CSV", () => {
    expect(piroFileKind("jobs-2026-02-09.csv", GENERIC_PIRO_PROFILE)).toBe("jobs");
    expect(piroFileKind("Work Order Status.CSV", GENERIC_PIRO_PROFILE)).toBe("jobs");
    expect(piroFileKind("casting-trees.csv", GENERIC_PIRO_PROFILE)).toBe("casting");
    expect(piroFileKind("casting tree jobs.csv", GENERIC_PIRO_PROFILE)).toBe("casting");
    expect(piroFileKind("jobs.xlsx", GENERIC_PIRO_PROFILE)).toBeNull();
    expect(piroFileKind("inventory.csv", GENERIC_PIRO_PROFILE)).toBeNull();
    expect(piroFileKind("wip-1.csv", parsePiroProfile(custom))).toBe("jobs");
    expect(piroFileKind("casting.csv", parsePiroProfile(custom))).toBeNull();
  });
});

describe("PIRO jobs", () => {
  const jobs = async () => (await eventsOf()).filter((e) => e.type === JOB_EVENT_TYPE);

  it("produces a job's state, keyed by its number and what it says", async () => {
    const [first, second] = await jobs();
    expect(first).toEqual({
      id: first!.idempotencyKey,
      type: "manufacturing.job_updated",
      occurredAt: "2026-01-20T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^piro:job:TEST-J-1001:[0-9a-f]{12}$/),
      payload: {
        system: "PIRO",
        jobId: "TEST-J-1001",
        status: "in_progress",
        statusLabel: "In Progress",
        stage: "Polishing",
        styleNumber: "TEST-STYLE-1",
        orderNumber: "TEST-SO-1",
        metal: "gold",
        karat: 14,
        quantity: 1,
        startedOn: "2026-01-10",
        dueOn: "2026-01-30",
        estimatedGrams: 5.2,
        treeId: "TEST-T-1",
        sourceRow: "jobs-2026-02-09.csv:2",
      },
    });
    expect(second!.payload).toMatchObject({ jobId: "TEST-J-1002", status: "completed", metal: "platinum", completedOn: "2026-01-22", estimatedGrams: 12, actualGrams: 12.45, weightVarianceGrams: 0.45 });
    expect(second!.payload).not.toHaveProperty("karat");
  });

  it("times a job by its last update, then its completed or start date, then the export", async () => {
    const byId = new Map((await jobs()).map((e) => [e.payload.jobId, e.occurredAt]));
    expect(byId.get("TEST-J-1002")).toBe("2026-01-22T00:00:00.000Z");
    expect(byId.get("TEST-J-1003")).toBe("2026-01-12T00:00:00.000Z");
    const noDates = await eventsOf(connector({}, { "jobs-2026-02-09.csv": "Job No,Status\nTEST-J-2001,Open" }));
    expect(noDates.find((e) => e.payload.jobId === "TEST-J-2001")!.occurredAt).toBe(EXPORTED);
  });

  it("gives a row it can't read no time and says what's wrong, so it is dead-lettered with the row", async () => {
    const bad = (await jobs()).filter((e) => e.occurredAt === undefined);
    expect(bad.map((e) => [e.idempotencyKey, e.payload])).toEqual([
      ["piro:unreadable_job:jobs-2026-02-09.csv:6", { system: "PIRO", jobId: "TEST-J-1005", problems: ['metal "Gold/Silver" is not one metal'], sourceRow: "jobs-2026-02-09.csv:6" }],
      ["piro:unreadable_job:jobs-2026-02-09.csv:7", { system: "PIRO", jobId: "TEST-J-1006", problems: ['quantity "two" is not a count'], sourceRow: "jobs-2026-02-09.csv:7" }],
      ["piro:unreadable_job:jobs-2026-02-09.csv:8", { system: "PIRO", jobId: null, problems: ["no job number"], sourceRow: "jobs-2026-02-09.csv:8" }],
    ]);
  });

  it("names each problem in a row, dates and weights included", async () => {
    const text = "Job No,Status,Start Date,Due Date,Karat,Qty,Est Weight (g),Actual Weight (dwt)\nTEST-J-3001,,13/45/2026,soon,30,-1,5 dwt,1 g";
    const [event] = (await eventsOf(connector({}, { "jobs-2026-02-09.csv": text }))).filter((e) => e.type === JOB_EVENT_TYPE);
    expect(event!.payload.problems).toEqual([
      "no status",
      'startDate "13/45/2026" is not a date',
      'dueDate "soon" is not a date',
      'karat "30" is not a karat',
      'quantity "-1" is not a count',
      "the estimated weight is not a weight in its column's unit",
      "the actual weight is not a weight in its column's unit",
    ]);
  });

  it("stores only what changed when the report is exported again", async () => {
    const source = memoryFileSource({ "jobs-2026-02-09.csv": JOBS }, EXPORTED);
    const make = () => piroConnector({ source, now: NOW });
    const { memory, pipeline } = testPipeline();
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 4, deadLettered: 3 });
    const next = JOBS.replace("TEST-J-1001,In Progress,01/20/2026,Polishing", "TEST-J-1001,Completed,02/09/2026,Shipping").replace(",01/30/2026,,5.200,", ",01/30/2026,02/09/2026,5.200,");
    source.files["jobs-2026-02-10.csv"] = next;
    // The new export's unchanged jobs are duplicates; its unreadable rows are dead-lettered again under the new file's name.
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, duplicates: 3, deadLettered: 3 });
    const versions = memory.events.filter((e) => e.payload.jobId === "TEST-J-1001").map((e) => [e.payload.status, e.occurredAt]);
    expect(versions).toEqual([
      ["in_progress", "2026-01-20T00:00:00.000Z"],
      ["completed", "2026-02-09T00:00:00.000Z"],
    ]);
  });
});

describe("PIRO casting trees", () => {
  const trees = async () => (await eventsOf()).filter((e) => e.type === CASTING_EVENT_TYPE);

  it("records metal issued and returned, and the loss between them, in grams", async () => {
    const [first] = await trees();
    expect(first).toEqual({
      id: first!.idempotencyKey,
      type: "manufacturing.casting_recorded",
      occurredAt: "2026-01-15T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^piro:casting:TEST-T-1:[0-9a-f]{12}$/),
      payload: {
        system: "PIRO",
        treeId: "TEST-T-1",
        castOn: "2026-01-15",
        metal: "gold",
        issuedGrams: dwt(100),
        karat: 14,
        statusLabel: "Closed",
        castingsGrams: dwt(60),
        scrapGrams: dwt(38.5),
        returnedGrams: dwt(98.5),
        lossGrams: Math.round((dwt(100) - dwt(98.5)) * 1000) / 1000,
        lossPercent: 1.5,
        jobIds: ["TEST-J-1001", "TEST-J-1007"],
        sourceRow: "casting-trees-2026-01.csv:2",
      },
    });
  });

  it("sums castings and scrap when the report has no returned total, and leaves loss out without either", async () => {
    const [, platinum, silver] = await trees();
    expect(platinum!.payload).toMatchObject({ treeId: "TEST-T-2", returnedGrams: Math.round((dwt(25) + dwt(14)) * 1000) / 1000, lossPercent: 2.5, jobIds: ["TEST-J-1002"] });
    expect(silver!.payload).toMatchObject({ treeId: "TEST-T-3", metal: "silver", issuedGrams: dwt(50) });
    expect(silver!.payload).not.toHaveProperty("lossGrams");
    expect(silver!.payload).not.toHaveProperty("jobIds");
  });

  it("dead-letters a tree with a weight in the wrong unit, an impossible date or an unknown metal", async () => {
    const bad = (await trees()).filter((e) => e.occurredAt === undefined);
    expect(bad.map((e) => [e.payload.treeId, e.payload.problems])).toEqual([
      ["TEST-T-4", ["the issued weight is not a weight in its column's unit"]],
      ["TEST-T-5", ['cast date "02/30/2026" is not a date']],
      ["TEST-T-6", ['metal "Rhodium" is not one metal']],
    ]);
  });

  it("names a tree with nothing issued, no metal, no date or no number", async () => {
    const text = "Tree No,Cast Date,Metal,Karat,Issued Weight (g)\nTEST-T-7,01/20/2026,,40,\n,01/20/2026,Gold,,5\nTEST-T-8,,Gold,,5";
    const events = await eventsOf(connector({}, { "casting-trees-2026-01.csv": text }));
    expect(events.filter((e) => e.type === CASTING_EVENT_TYPE).map((e) => e.payload.problems)).toEqual([
      ["no metal", 'karat "40" is not a karat', "no metal issued"],
      ["no tree number"],
      ["no cast date"],
    ]);
  });
});

describe("PIRO connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ JOBS, OLD_JOBS, CASTING });
  });

  it("declares no writes, and the write gate turns every one down", async () => {
    expect(PIRO_WRITES).toEqual([]);
    expect(await assertWritesRefused(connector())).toEqual([]);
  });

  it("survives every runSync scenario, dead-lettering the rows it can't read", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 7, deadLettered: 6 } });
    // Casting 6 in two batches; the 2019 jobs file empty in one; this year's jobs 7 in three.
    expect(result.full.batches).toBe(6);
    expect(result.replay.duplicates).toBe(7);
    expect(JSON.parse(result.full.cursor!)).toEqual({
      done: { "casting-trees-2026-01.csv": sha256(CASTING), "jobs-2019.csv": sha256(OLD_JOBS), "jobs-2026-02-09.csv": sha256(JOBS) },
      current: null,
    });
  });

  it("skips rows older than the history window, unless the window is wider", async () => {
    expect((await eventsOf()).some((e) => e.payload.jobId === "TEST-J-0001")).toBe(false);
    expect((await eventsOf(connector({ historyYears: 8 }))).some((e) => e.payload.jobId === "TEST-J-0001")).toBe(true);
    const oldTree = "Tree No,Cast Date,Metal,Issued Weight (g)\nTEST-T-9,01/02/2019,Gold,5";
    expect(await eventsOf(connector({}, { "casting-trees-2026-01.csv": oldTree, "jobs-2026-02-09.csv": "Job No,Status" }))).toEqual([]);
  });

  it("names the file when a report can't be read, and stops there", async () => {
    await expect(eventsOf(connector({}, { "jobs-2026-02-09.csv": "Job No,Department\nTEST-J-1,Polishing" }))).rejects.toThrow(new PiroFileError("jobs-2026-02-09.csv", "has no column for Status or Job Status"));
    await expect(eventsOf(connector({}, { "casting-trees-2026-01.csv": 'Tree No,Cast Date,Metal\n"TEST,01/01/2026,Gold' }))).rejects.toThrow(new PiroFileError("casting-trees-2026-01.csv", "CSV line 2: a quoted field is never closed"));
  });

  it("rejects bad options", () => {
    expect(() => connector({ batchSize: 0 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector({ historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
  });

  it("checks the checkpoint it resumes from", () => {
    expect(parsePiroCursor(null)).toBeNull();
    expect(() => parsePiroCursor('{"done":[1]}')).toThrow("PIRO import checkpoint is not in the expected shape");
  });

  it("reads with a client's own profile and status labels", async () => {
    const profile = parsePiroProfile({
      id: "test_shop",
      name: "Test shop",
      delimiter: ";",
      dateOrder: "dmy",
      files: { jobs: "^bags" },
      columns: { jobs: { jobId: "Bag", status: "State", updatedDate: "Changed", actualDwt: "Net DWT" } },
      statuses: { "stone sourcing": "on_hold" },
    });
    const source = memoryFileSource({ "bags.csv": "Bag;State;Changed;Net DWT\nTEST-B-1;Stone sourcing;03/02/2026;2.5", "jobs.csv": JOBS }, EXPORTED);
    const events = await eventsOf(piroConnector({ source, profile, now: NOW }));
    expect(events.map((e) => [e.payload.jobId, e.payload.status, e.occurredAt, e.payload.actualGrams])).toEqual([["TEST-B-1", "on_hold", "2026-02-03T00:00:00.000Z", dwt(2.5)]]);
  });
});
