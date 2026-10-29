import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, statementPage, syntheticPdf, testPipeline } from "@karatos/connector-testkit";
import {
  GENERIC_REFINER_PROFILE,
  GRAMS_PER,
  REFINER_STATEMENT_WRITES,
  RefinerProfileError,
  SettlementFileError,
  csvSettlementLines,
  fineWeightCheck,
  memoryFileSource,
  parseFineness,
  parseRefinerMetal,
  parseRefinerProfile,
  parseRefinerStatementCursor,
  parseWeight,
  refinerStatementsConnector,
  refinersFromDirectory,
  resolveRefinerProfiles,
  settlementEvents,
  sha256,
  type RefinerEvent,
  type RefinerSource,
  type RefinerStatementOptions,
  type SettlementLine,
} from "../src/index.js";

const NOW = () => new Date("2026-02-10T00:00:00Z");
const RECEIVED = "2026-02-10T00:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

/** A statement in pennyweight, the way many US refiners settle jewelers' scrap. */
const JANUARY = [
  "Test Refinery Settlement Statement",
  "Account TEST-ACCT",
  "Period 01/01/2026 - 01/31/2026",
  "",
  "Settlement Date,Lot,Metal,Description,Gross DWT,Melt DWT,Assay,Fine DWT,Price per Oz,Credit,Fee,Net",
  '01/05/2026,TEST-LOT-01,Gold,14K scrap,100.00,96.00,58.5%,56.16,"2,500.00","$6,669.00",(150.00),"6,519.00"',
  "01/05/2026,TEST-LOT-01,Silver,14K scrap,100.00,96.00,2.0%,1.92,30.00,2.50,,2.50",
  '01/12/2026,TEST-LOT-02,Gold,18K bench sweeps,50.00,48.00,75%,30.00,"2,550.00","$3,500.00",75.00,"3,425.00"',
  "01/20/2026,TEST-LOT-03,AU,filings,,20.00,0.585,,,,,",
  "01/22/2026,TEST-LOT-04,Gold,bad weight,abc,,58.5%,,,,,",
  "01/23/2026,,Gold,no lot,10.00,,58.5%,5.85,,,,",
  ',Total,,,,,,,,"$10,371.50",,',
].join("\r\n");

const OLD = "Settlement Date,Lot,Metal,Fine DWT\n01/02/2019,TEST-LOT-OLD,Gold,10.00";

/** A second refiner settling in grams. */
const GRAMS = ["Date,Lot Number,Metal Type,Gross Grams,Fineness,Fine Grams,Metal Value", "01/15/2026,TEST-PT-01,Platinum,20.000,950,19.000,$950.00"].join("\n");

function refiners(extra: Record<string, string | Uint8Array> = {}): RefinerSource[] {
  return [
    { id: "test_refinery", source: memoryFileSource({ "2026-01.csv": JANUARY, "2019.csv": OLD, ...extra }) },
    { id: "other_refinery", source: memoryFileSource({ "jan.csv": GRAMS }) },
  ];
}

function connector(options: Partial<RefinerStatementOptions> = {}) {
  return refinerStatementsConnector({ refiners: refiners(), now: NOW, batchSize: 3, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as RefinerEvent[]);

function departmentsPipeline() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
  return { memory, pipeline };
}

const dwt = (n: number) => Math.round(n * GRAMS_PER.Dwt * 1000) / 1000;

describe("reading refiner values", () => {
  it("reads a weight in its column's unit, to the milligram", () => {
    expect(parseWeight("10", "Grams")).toBe(10);
    expect(parseWeight("1,250.5", "Grams")).toBe(1250.5);
    expect(parseWeight("1", "Dwt")).toBe(1.555);
    expect(parseWeight("12.5 dwt", "Dwt")).toBe(19.44);
    expect(parseWeight("1 ozt", "Ozt")).toBe(31.103);
    expect(parseWeight("2 troy oz", "Ozt")).toBe(62.207);
    expect(parseWeight(" 3 g ", "Grams")).toBe(3);
  });

  it("rejects a weight it can't read for certain, including one labeled in another unit", () => {
    for (const text of [undefined, "", "  ", "abc", "0", "0.000", "-5", "1.2.3", "1,25", "12.5 g"]) expect(parseWeight(text, "Dwt"), String(text)).toBeNull();
    expect(parseWeight("12.5 dwt", "Grams")).toBeNull();
    expect(parseWeight("1 oz", "Dwt")).toBeNull();
  });

  it("reads fineness as a percentage, a fraction, parts per thousand or karat", () => {
    const cases: [string, number | null][] = [
      ["58.5%", 0.585],
      ["58.5 %", 0.585],
      ["0.585", 0.585],
      ["58.5", 0.585],
      ["585", 0.585],
      ["999.9", 0.9999],
      ["1", 1],
      ["100", 1],
      ["100%", 1],
      ["14K", 0.583333],
      ["14 kt", 0.583333],
      ["18karat", 0.75],
      ["24k", 1],
      ["25K", null],
      ["0K", null],
      ["0", null],
      ["101%", null],
      ["1001", null],
      ["fine", null],
      ["", null],
    ];
    for (const [text, expected] of cases) expect(parseFineness(text), text).toBe(expected);
    expect(parseFineness(undefined)).toBeNull();
  });

  it("names the metal from words or symbols, and only one metal", () => {
    expect(parseRefinerMetal("Gold")).toBe("gold");
    expect(parseRefinerMetal("AU")).toBe("gold");
    expect(parseRefinerMetal("14K gold scrap")).toBe("gold");
    expect(parseRefinerMetal("Ag")).toBe("silver");
    expect(parseRefinerMetal("Pt")).toBe("platinum");
    expect(parseRefinerMetal("PLAT")).toBe("platinum");
    expect(parseRefinerMetal("Palladium")).toBe("palladium");
    expect(parseRefinerMetal("PD")).toBe("palladium");
    expect(parseRefinerMetal("Gold/Silver")).toBeNull();
    expect(parseRefinerMetal("Rhodium")).toBeNull();
    expect(parseRefinerMetal("Augusta")).toBeNull();
    expect(parseRefinerMetal(undefined)).toBeNull();
    expect(parseRefinerMetal(" ")).toBeNull();
  });
});

describe("refiner statement profiles", () => {
  const custom = { id: "test_refiner", name: "Test Refiner", columns: { date: "Settled", lot: "Lot", metal: "Metal", fineGrams: "Pure" } };

  it("fills defaults and accepts a client's own profile", () => {
    expect(parseRefinerProfile(custom)).toMatchObject({ delimiter: ",", dateOrder: "mdy" });
    expect(parseRefinerProfile({ ...custom, columns: { date: "D", lot: "L", metal: "M", meltDwt: "Melt", fineness: "Assay" } }).columns.meltDwt).toBe("Melt");
  });

  it("rejects a profile that can't find the fine metal, or has a bad layout, saying where", () => {
    expect(() => parseRefinerProfile({ ...custom, columns: { date: "D", lot: "L", metal: "M" } })).toThrow(new RefinerProfileError("refiner statement profile: columns need a fine weight (or a weight and fineness)"));
    expect(() => parseRefinerProfile({ ...custom, columns: { date: "D", lot: "L", metal: "M", fineness: "Assay" } })).toThrow(/columns need a fine weight/);
    expect(() => parseRefinerProfile({ ...custom, columns: { date: "D", metal: "M", fineGrams: "F" } })).toThrow(/columns\.lot/);
    expect(() => parseRefinerProfile({ ...custom, id: "Bad" })).toThrow(/id:/);
    expect(() => parseRefinerProfile({ ...custom, pdf: { line: "(" } })).toThrow(new RefinerProfileError("refiner statement profile: pdf.line is not a valid pattern"));
    expect(() => parseRefinerProfile({ ...custom, pdf: { line: "(?<date>x)", ignore: ["["] } })).toThrow("pdf.ignore.0 is not a valid pattern");
    expect(() => parseRefinerProfile({ ...custom, pdf: { line: "(?<date>x) (?<lot>x) (?<metal>x)" } })).toThrow("pdf.line needs named groups for a fine weight (or a weight and fineness)");
    expect(() => parseRefinerProfile({ ...custom, pdf: { line: ["(?<date>x) (?<lot>x) (?<metal>x) (?<fineDwt>x)", "(?<lot>x) (?<fineDwt>x)"] } })).toThrow("pdf.line.1 needs named groups for date, metal");
    expect(() => parseRefinerProfile({ ...custom, pdf: { line: "(?<date>x) (?<lot>x) (?<metal>x) (?<fineDwt>x) (?<karat>x)" } })).toThrow("pdf.line has groups no field is named for: karat");
  });

  it("resolves REFINER_STATEMENTS_PROFILES to the generic profile or a per-refiner JSON file, without echoing it", async () => {
    expect((await resolveRefinerProfiles(undefined))("test_refinery")).toBe(GENERIC_REFINER_PROFILE);
    expect((await resolveRefinerProfiles(" generic "))("x")).toBe(GENERIC_REFINER_PROFILE);
    const file = JSON.stringify({ test_refinery: custom, other_refinery: "generic", "*": { ...custom, id: "test_rest" } });
    const lookup = await resolveRefinerProfiles("/instance/refiners.json", async () => file);
    expect(lookup("test_refinery").id).toBe("test_refiner");
    expect(lookup("other_refinery")).toBe(GENERIC_REFINER_PROFILE);
    expect(lookup("third_refinery").id).toBe("test_rest");
    expect((await resolveRefinerProfiles("/i.json", async () => JSON.stringify({ test_refinery: custom })))("other_refinery")).toBe(GENERIC_REFINER_PROFILE);
    await expect(resolveRefinerProfiles("/i.json", async () => "{ SECRET-LOOKING")).rejects.toThrow(/^REFINER_STATEMENTS_PROFILES: could not read a JSON file \(SyntaxError\)$/);
    await expect(resolveRefinerProfiles("/i.json", async () => "[]")).rejects.toThrow(/must map refiner folders/);
    await expect(resolveRefinerProfiles("/i.json", async () => "null")).rejects.toThrow(/must map refiner folders/);
    await expect(resolveRefinerProfiles("/i.json", async () => JSON.stringify({ x: "chase" }))).rejects.toThrow('"x" names no built-in profile');
    await expect(resolveRefinerProfiles("/i.json", async () => JSON.stringify({ x: { id: "BAD" } }))).rejects.toThrow(RefinerProfileError);
    const dir = await mkdtemp(join(tmpdir(), "refiner-profile-"));
    await writeFile(join(dir, "refiners.json"), file);
    expect((await resolveRefinerProfiles(join(dir, "refiners.json")))("test_refinery").id).toBe("test_refiner");
  });
});

describe("reading a settlement statement", () => {
  const lines = () => csvSettlementLines(JANUARY, GENERIC_REFINER_PROFILE, "test_refinery/2026-01.csv");

  it("finds the header below the title block, keeps true line numbers and skips the total", () => {
    expect(lines().map((l) => l.sourceRow)).toEqual([6, 7, 8, 9, 10, 11].map((n) => `test_refinery/2026-01.csv:${n}`));
  });

  it("reads a lot's weights in grams, its assay, and its money in cents, with fees as money taken", () => {
    expect(lines()[0]).toEqual({
      sourceRow: "test_refinery/2026-01.csv:6",
      occurredAt: "2026-01-05T00:00:00.000Z",
      lot: "TEST-LOT-01",
      metal: "gold",
      description: "14K scrap",
      grossGrams: dwt(100),
      meltGrams: dwt(96),
      fineness: 0.585,
      fineGrams: dwt(56.16),
      fineFrom: "statement",
      pricePerTroyOunceCents: 250_000,
      creditCents: 666_900,
      feeCents: 15_000,
      netCents: 651_900,
    });
    expect(lines()[2]!.feeCents).toBe(7_500);
  });

  it("works out the fine metal from the melt weight and assay when the statement leaves it out", () => {
    const line = lines()[3]!;
    expect(line).toMatchObject({ lot: "TEST-LOT-03", metal: "gold", meltGrams: dwt(20), fineness: 0.585, fineFrom: "assay" });
    expect(line.fineGrams).toBe(Math.round(dwt(20) * 0.585 * 1000) / 1000);
    expect(line).not.toHaveProperty("grossGrams");
    expect(line).not.toHaveProperty("creditCents");
    const both = csvSettlementLines("Date,Lot,Metal,Gross Grams,Melt Grams,Assay\n01/02/2026,TEST-LOT-13,Gold,10,8,50%", GENERIC_REFINER_PROFILE, "b.csv")[0]!;
    expect(both).toMatchObject({ grossGrams: 10, meltGrams: 8, fineGrams: 4, fineFrom: "assay" });
  });

  it("leaves what it can't read as null, so the line is dead-lettered and kept", () => {
    expect(lines()[4]).toMatchObject({ lot: "TEST-LOT-04", grossGrams: null, fineGrams: null, fineFrom: "statement" });
    expect(lines()[5]).toMatchObject({ lot: null, fineGrams: dwt(5.85) });
  });

  it("reads a statement in grams with parts-per-thousand fineness through the generic profile", () => {
    expect(csvSettlementLines(GRAMS, GENERIC_REFINER_PROFILE, "g.csv")).toEqual([
      { sourceRow: "g.csv:2", occurredAt: "2026-01-15T00:00:00.000Z", lot: "TEST-PT-01", metal: "platinum", grossGrams: 20, fineness: 0.95, fineGrams: 19, fineFrom: "statement", creditCents: 95_000 },
    ]);
  });

  it("marks an unreadable price as null, and a zero price as unreadable too", () => {
    const text = ["Date,Lot,Metal,Fine Grams,Price", "01/02/2026,TEST-LOT-09,Gold,1.000,abc", "01/02/2026,TEST-LOT-10,Gold,1.000,0.00"].join("\n");
    expect(csvSettlementLines(text, GENERIC_REFINER_PROFILE, "p.csv").map((l) => l.pricePerTroyOunceCents)).toEqual([null, null]);
  });

  it("names the missing columns when no row looks like the header", () => {
    expect(() => csvSettlementLines("Date,Metal,Fine Grams\n01/02/2026,Gold,1", GENERIC_REFINER_PROFILE, "x.csv")).toThrow("x.csv has no column for Lot or Lot Number or Lot # or Lot No or Reference or Ref");
    expect(() => csvSettlementLines("Date,Lot,Metal,Description\n01/02/2026,L1,Gold,scrap", GENERIC_REFINER_PROFILE, "x.csv")).toThrow("x.csv has no column for a fine weight (or a weight and fineness)");
    expect(csvSettlementLines("Date,Lot,Metal,Gross Grams,Assay\n01/02/2026,TEST-LOT-11,Gold,10,75%", GENERIC_REFINER_PROFILE, "x.csv")[0]).toMatchObject({ fineGrams: 7.5, fineFrom: "assay" });
  });
});

describe("checking the fine weight", () => {
  const line = (over: Partial<SettlementLine>) => ({ grossGrams: 100, fineness: 0.585, fineGrams: 58.5, fineFrom: "statement" as const, ...over });

  it("matches within rounding, and differs beyond half a percent or ten milligrams", () => {
    expect(fineWeightCheck(line({}))).toEqual({ check: "matches", expectedFineGrams: 58.5 });
    expect(fineWeightCheck(line({ fineGrams: 58.21 }))).toEqual({ check: "matches", expectedFineGrams: 58.5 });
    expect(fineWeightCheck(line({ fineGrams: 58.2 }))).toEqual({ check: "differs", expectedFineGrams: 58.5 });
    expect(fineWeightCheck(line({ fineGrams: 58.19 }))).toEqual({ check: "differs", expectedFineGrams: 58.5 });
    expect(fineWeightCheck(line({ fineGrams: 58.81 }))).toEqual({ check: "differs", expectedFineGrams: 58.5 });
    expect(fineWeightCheck(line({ grossGrams: 1, fineness: 0.5, fineGrams: 0.51 }))).toEqual({ check: "matches", expectedFineGrams: 0.5 });
    expect(fineWeightCheck(line({ grossGrams: 1, fineness: 0.5, fineGrams: 0.511 }))).toEqual({ check: "differs", expectedFineGrams: 0.5 });
  });

  it("uses the melt weight over the gross weight, since the assay is taken on the melt", () => {
    expect(fineWeightCheck(line({ meltGrams: 96, fineGrams: 56.16 }))).toEqual({ check: "matches", expectedFineGrams: 56.16 });
    expect(fineWeightCheck(line({ meltGrams: 96 }))).toEqual({ check: "differs", expectedFineGrams: 56.16 });
  });

  it("checks nothing it worked out itself, or without both a weight and an assay", () => {
    expect(fineWeightCheck(line({ fineFrom: "assay" }))).toEqual({ check: "not_checked" });
    expect(fineWeightCheck({ fineness: 0.585, fineGrams: 58.5, fineFrom: "statement" })).toEqual({ check: "not_checked" });
    expect(fineWeightCheck(line({ grossGrams: null }))).toEqual({ check: "not_checked" });
    expect(fineWeightCheck(line({ fineness: null }))).toEqual({ check: "not_checked" });
    expect(fineWeightCheck(line({ fineGrams: null }))).toEqual({ check: "not_checked" });
  });
});

describe("settlement events", () => {
  const ctx = { refiner: "test_refinery", fileName: "f.csv", receivedAt: RECEIVED, since: "2021-02-10T00:00:00.000Z" };
  const read = (text: string, file = "f.csv") => settlementEvents(csvSettlementLines(text, GENERIC_REFINER_PROFILE, file), ctx);

  it("produces metals-shaped lines with the fine weight check", () => {
    const [gold, silver, short] = read(JANUARY);
    expect(gold).toEqual({
      id: gold!.idempotencyKey,
      type: "refining.settlement_line_imported",
      occurredAt: "2026-01-05T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^refiner:test_refinery:TEST-LOT-01:gold:0:[0-9a-f]{12}$/),
      payload: {
        lineId: "refiner:test_refinery:TEST-LOT-01:gold:0",
        refiner: "test_refinery",
        lot: "TEST-LOT-01",
        settledOn: "2026-01-05",
        metal: "gold",
        description: "14K scrap",
        grossGrams: dwt(100),
        meltGrams: dwt(96),
        fineness: 0.585,
        fineGrams: dwt(56.16),
        pricePerTroyOunceCents: 250_000,
        creditCents: 666_900,
        feeCents: 15_000,
        netCents: 651_900,
        fineFrom: "statement",
        fineTroyOunces: 2.808,
        fineWeightCheck: "matches",
        expectedFineGrams: Math.round(dwt(96) * 0.585 * 1000) / 1000,
        currency: "USD",
        sourceRow: "f.csv:6",
      },
    });
    expect(silver!.payload).toMatchObject({ lineId: "refiner:test_refinery:TEST-LOT-01:silver:0", metal: "silver", fineWeightCheck: "matches" });
    expect(short!.payload).toMatchObject({ lot: "TEST-LOT-02", fineGrams: dwt(30), expectedFineGrams: dwt(36), fineWeightCheck: "differs" });
  });

  it("keys unreadable lines by where they are", () => {
    const events = read(JANUARY);
    expect(events.slice(4).map((e) => [e.idempotencyKey, e.occurredAt])).toEqual([
      ["refiner:test_refinery:row:f.csv:10", "2026-01-22T00:00:00.000Z"],
      ["refiner:test_refinery:row:f.csv:11", "2026-01-23T00:00:00.000Z"],
    ]);
    const badDate = read("Date,Lot,Metal,Fine Grams\n13/45/2026,TEST-LOT-12,Gold,1.000");
    expect(badDate.map((e) => [e.idempotencyKey, e.occurredAt, e.payload.settledOn])).toEqual([["refiner:test_refinery:row:f.csv:2", undefined, null]]);
  });

  it("numbers a lot's lines for one metal, and keys the same line the same in any file", () => {
    const twice = "Date,Lot,Metal,Fine Grams\n01/02/2026,TEST-LOT-20,Gold,1.000\n01/02/2026,TEST-LOT-20,Gold,1.000\n01/02/2026,TEST-LOT-20,Silver,1.000";
    const first = read(twice, "a.csv");
    expect(first.map((e) => e.payload.lineId)).toEqual(["refiner:test_refinery:TEST-LOT-20:gold:0", "refiner:test_refinery:TEST-LOT-20:gold:1", "refiner:test_refinery:TEST-LOT-20:silver:0"]);
    expect(new Set(first.map((e) => e.idempotencyKey)).size).toBe(3);
    expect(read(twice, "b.csv").map((e) => e.idempotencyKey)).toEqual(first.map((e) => e.idempotencyKey));
  });

  it("keys a corrected line as a new version of the same lot", () => {
    const before = read("Date,Lot,Metal,Fine Grams\n01/02/2026,TEST-LOT-21,Gold,1.000")[0]!;
    const after = read("Date,Lot,Metal,Fine Grams\n01/02/2026,TEST-LOT-21,Gold,1.200")[0]!;
    expect(after.payload.lineId).toBe(before.payload.lineId);
    expect(after.idempotencyKey).not.toBe(before.idempotencyKey);
  });

  it("skips lines older than the history window", () => {
    expect(read(OLD)).toEqual([]);
    expect(settlementEvents(csvSettlementLines(OLD, GENERIC_REFINER_PROFILE, "o.csv"), { ...ctx, since: "2018-01-01T00:00:00.000Z" })).toHaveLength(1);
  });
});

describe("refiner statements connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ JANUARY, OLD, GRAMS });
  });

  it("declares no writes, and the write gate turns every one down", async () => {
    expect(REFINER_STATEMENT_WRITES).toEqual([]);
    expect(connector().writes).toEqual([]);
    expect(await assertWritesRefused(connector())).toEqual([]);
  });

  it("survives every runSync scenario, with the metals schema dead-lettering unreadable lines", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), payloadSchemas: SCHEMAS, expected: { ingested: 5, deadLettered: 2 } });
    // other_refinery 1 in one batch; the 2019 file empty in one; January's 6 in two.
    expect(result.full.batches).toBe(4);
    expect(result.replay.duplicates).toBe(5);
    expect(JSON.parse(result.full.cursor!)).toEqual({
      done: { "other_refinery/jan.csv": sha256(GRAMS), "test_refinery/2019.csv": sha256(OLD), "test_refinery/2026-01.csv": sha256(JANUARY) },
      current: null,
    });
  });

  it("feeds the metals department the lines it accepts, and dead-letters exactly the bad ones", async () => {
    const { memory, pipeline } = departmentsPipeline();
    expect(await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 5, deadLettered: 2 });
    expect(memory.deadLetters.map((d) => [(d.raw as RefinerEvent).payload.sourceRow, d.issues.map((i) => i.path).sort()])).toEqual([
      ["test_refinery/2026-01.csv:10", ["payload.fineGrams", "payload.fineTroyOunces", "payload.grossGrams"]],
      ["test_refinery/2026-01.csv:11", ["payload.lot"]],
    ]);
  });

  it("flags the lot credited short, and a lot paid well under spot, once the spot price is in", async () => {
    const { memory, pipeline } = departmentsPipeline();
    await pipeline.ingest({ id: "spot1", organizationId: TEST_ORG, source: "metals_api", type: "metal.price_updated", occurredAt: "2026-01-11T21:00:00Z", receivedAt: RECEIVED, idempotencyKey: "spot1", payload: { metal: "gold", spotPerTroyOunceCents: 270_000 } });
    await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const summaries = (await pipeline.reason(TEST_ORG)).map((r) => r.summary);
    expect(summaries).toEqual([
      "Lot TEST-LOT-02 from test_refinery credits 46.66 g of fine gold, but 74.65 g at 75% is 55.99 g. Ask the refiner to recheck the assay on the 9.33 g short.",
      "Lot TEST-LOT-02 from test_refinery paid $3,500.00 for 1.5 oz of fine gold, 86.4% of spot on 2026-01-12, before $75.00 in fees. Get a second quote on payable rates and fees.",
    ]);
  });

  it("stores a lot once when an overlapping export has it too, and a corrected one as its newer version", async () => {
    const source = memoryFileSource({ "2026-01.csv": JANUARY });
    const make = () => refinerStatementsConnector({ refiners: [{ id: "test_refinery", source }], now: NOW });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 4, deadLettered: 2 });
    source.files["2026-01-corrected.csv"] = [
      "Lot #,Metal,Statement Date,Melt DWT,Assay %,Fine DWT,Value",
      "TEST-LOT-01,Gold,01/05/2026,96.00,58.5%,56.16,\"$6,669.00\"",
      "TEST-LOT-02,Gold,01/12/2026,48.00,75%,36.00,\"$4,200.00\"",
    ].join("\n");
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 2, duplicates: 0, deadLettered: 0 });
  });

  it("reads nothing again when no file changed", async () => {
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const c = connector();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ batches: 0, ingested: 0, duplicates: 0 });
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 5 });
  });

  it("keeps two refiners' files apart, even with the same file name and lot", async () => {
    const same = "Date,Lot,Metal,Fine Grams\n01/02/2026,TEST-LOT-30,Gold,1.000";
    const c = refinerStatementsConnector({ refiners: [{ id: "a_refinery", source: memoryFileSource({ "s.csv": same }) }, { id: "b_refinery", source: memoryFileSource({ "s.csv": same }) }], now: NOW });
    const events = await eventsOf(c);
    expect(events.map((e) => [e.payload.lineId, e.payload.sourceRow])).toEqual([
      ["refiner:a_refinery:TEST-LOT-30:gold:0", "a_refinery/s.csv:2"],
      ["refiner:b_refinery:TEST-LOT-30:gold:0", "b_refinery/s.csv:2"],
    ]);
  });

  it("names the file when a statement can't be read, and stops there", async () => {
    const broken = refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "bad.csv": 'Date,Lot,Metal,Fine Grams\n01/02/2026,"TEST,Gold,1' }) }], now: NOW });
    await expect(eventsOf(broken)).rejects.toThrow(new SettlementFileError("test_refinery/bad.csv", "CSV line 2: a quoted field is never closed"));
    const noColumns = refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "x.csv": "Date,Metal\n01/02/2026,Gold" }) }], now: NOW });
    await expect(eventsOf(noColumns)).rejects.toThrow(/^test_refinery\/x\.csv: has no column for Lot/);
  });

  it("reads only the formats asked for, and rejects bad options", async () => {
    const pdf = syntheticPdf([statementPage([[[50, "x"]]])]);
    const c = connector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "a.csv": GRAMS, "b.pdf": pdf, "notes.txt": "x" }) }], formats: ["csv"] });
    expect((await eventsOf(c)).map((e) => e.payload.sourceRow)).toEqual(["test_refinery/a.csv:2"]);
    expect(() => connector({ formats: [] })).toThrow("formats must list csv, pdf or both");
    expect(() => connector({ formats: ["xlsx" as "csv"] })).toThrow("formats must list csv, pdf or both");
    expect(() => connector({ batchSize: 0 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector({ historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector({ refiners: [{ id: "Test Refinery", source: memoryFileSource({}) }] })).toThrow('refiner "Test Refinery" must be a lowercase folder name');
    expect(() => connector({ refiners: [...refiners(), refiners()[0]!] })).toThrow("refiner test_refinery is listed twice");
  });

  it("takes the history window from its options", async () => {
    expect((await eventsOf(connector({ historyYears: 8 }))).some((e) => e.payload.lot === "TEST-LOT-OLD")).toBe(true);
    expect((await eventsOf(connector())).some((e) => e.payload.lot === "TEST-LOT-OLD")).toBe(false);
  });

  it("checks the checkpoint it resumes from", () => {
    expect(parseRefinerStatementCursor(null)).toBeNull();
    expect(() => parseRefinerStatementCursor('{"done":null}')).toThrow("Refiner statement import checkpoint is not in the expected shape");
  });

  it("finds one refiner per lowercase folder, and skips the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refiners-"));
    for (const name of ["test_refinery", "Other Refinery", "x", "9refinery"]) await mkdir(join(dir, name));
    await writeFile(join(dir, "loose.csv"), GRAMS);
    await writeFile(join(dir, "test_refinery", "jan.csv"), GRAMS);
    const found = await refinersFromDirectory(dir);
    expect(found.map((r) => [r.id, r.profile])).toEqual([["test_refinery", GENERIC_REFINER_PROFILE]]);
    const events = await eventsOf(refinerStatementsConnector({ refiners: found, now: NOW }));
    expect(events.map((e) => e.payload.lot)).toEqual(["TEST-PT-01"]);
  });
});

describe("PDF settlement statements", () => {
  const W = String.raw`[\d,]+\.\d+`;
  const layout = {
    line: String.raw`^(?<date>\d{2}/\d{2}/\d{4})\s{2,}(?<lot>TEST-\S+)\s{2,}(?<metal>[A-Za-z]+)\s{2,}(?<grossGrams>${W})\s{2,}(?<fineness>[\d.]+%?)\s{2,}(?<fineGrams>${W})\s{2,}(?<credit>\$[\d,]+\.\d{2})$`,
    ignore: [String.raw`^total\b`, String.raw`\bTEST-VOID-`],
  };
  const profile = parseRefinerProfile({ ...GENERIC_REFINER_PROFILE, id: "test_pdf", name: "Test PDF Refiner", pdf: layout });
  const columns = (...cells: string[]): [number, string][] => cells.map((text, i) => [50 + i * 80, text]);
  const STATEMENT = syntheticPdf([
    statementPage([
      [[50, "Test Refinery PDF Settlement"]],
      columns("Date", "Lot", "Metal", "Gross g", "Assay", "Fine g", "Credit"),
      columns("01/06/2026", "TEST-LOT-40", "Gold", "31.104", "75%", "23.328", "$1,890.00"),
      columns("01/07/2026", "TEST-LOT-41", "Silver", "100.000", "92.5%", "92.500", "$89.00"),
      columns("01/08/2026", "TEST-VOID-42", "Gold", "10.000", "75%", "7.500", "$600.00"),
      columns("Total", "", "", "", "", "", "$2,579.00"),
    ]),
  ]);

  it("reads each settlement line with the profile's layout, keyed by page and line, skipping the lines it's told to", async () => {
    const c = refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "jan.pdf": STATEMENT }), profile }], now: NOW });
    const events = await eventsOf(c);
    expect(events.map((e) => [e.payload.lot, e.payload.metal, e.payload.fineGrams, e.payload.creditCents, e.payload.fineWeightCheck, e.payload.sourceRow])).toEqual([
      ["TEST-LOT-40", "gold", 23.328, 189_000, "matches", "test_refinery/jan.pdf:p1:3"],
      ["TEST-LOT-41", "silver", 92.5, 8_900, "matches", "test_refinery/jan.pdf:p1:4"],
    ]);
  });

  it("stores a lot once when its CSV export and PDF statement both have it", async () => {
    const csv = "Date,Lot,Metal,Gross Grams,Assay,Fine Grams,Credit\n01/06/2026,TEST-LOT-40,Gold,31.104,75%,23.328,\"$1,890.00\"";
    const make = () => refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "jan.pdf": STATEMENT, "lot40.csv": csv }), profile }], now: NOW });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 2, duplicates: 1 });
  });

  it("asks for a CSV or a layout instead of guessing at a PDF with no layout", async () => {
    const c = refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "jan.pdf": STATEMENT }) }], now: NOW });
    await expect(eventsOf(c)).rejects.toThrow(new SettlementFileError("test_refinery/jan.pdf", "the Generic CSV profile has no PDF layout; export the statement as CSV or add a layout to the profile"));
  });

  it("names a PDF the layout matches nothing in, and one that isn't a PDF", async () => {
    const other = syntheticPdf([statementPage([[[50, "Quarterly newsletter"]]])]);
    const c = refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "news.pdf": other }), profile }], now: NOW });
    await expect(eventsOf(c)).rejects.toThrow(new SettlementFileError("test_refinery/news.pdf", "has no settlement lines the profile's PDF layout matches"));
    const notPdf = refinerStatementsConnector({ refiners: [{ id: "test_refinery", source: memoryFileSource({ "x.pdf": "not a pdf" }), profile }], now: NOW });
    await expect(eventsOf(notPdf)).rejects.toThrow(new SettlementFileError("test_refinery/x.pdf", "is not a readable PDF"));
  });
});
