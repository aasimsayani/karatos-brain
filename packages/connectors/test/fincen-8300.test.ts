import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  FILING_EVENT_TYPE,
  FINCEN_8300_WRITES,
  Fincen8300FileError,
  filingStatus,
  fincen8300Connector,
  isFilingsLog,
  memoryFileSource,
  parseFincen8300Cursor,
  saleIdList,
  sha256,
  type Fincen8300Options,
  type Form8300Event,
} from "../src/index.js";

const NOW = () => new Date("2026-02-10T00:00:00Z");
const RECEIVED = "2026-02-10T00:00:00.000Z";
const EXPORTED = "2026-02-09T23:00:00.000Z";

/** A filings log as a store keeps it, from the template in docs/integrations/fincen_8300.md. */
const LOG = [
  "Filed On,Cash Received On,Sale IDs,Customer ID,Cash Amount,BSA Tracking ID,BSA ID,Status,Statement Sent On,Suspicious",
  "01/12/2026,01/05/2026,TEST-S-1001,TEST-C-1,\"$12,400.00\",7700123,31000000123457,Accepted,01/20/2026",
  "01/20/2026,01/08/2026,TEST-S-1002; TEST-S-1003,TEST-C-2,\"$10,850.00\",7700124,,Submitted,",
  "01/25/2026,01/10/2026,TEST-S-1004,,\"$15,000.00\",7700125,,Rejected,",
  "02/01/2026,01/28/2026,TEST-S-1005,TEST-C-3,\"$11,000\",,,Accepted with Warnings,",
  "02/02/2026,01/29/2026,TEST-S-1006,,\"$9,000.00\",,,,,Yes",
  "02/03/2026,02/04/2026,TEST-S-1007,,\"$12,000.00\",,,Filed,",
  "02/03/2026,,TEST-S-1008,,abc,12,123,Lost,02/30/2026,maybe",
  ",,,,,,,,",
].join("\r\n");

const OLD_LOG = "Filed On,Cash Received On,Sale IDs,Cash Amount\n03/01/2019,02/20/2019,TEST-S-0001,\"$20,000.00\"";

function connector(options: Partial<Fincen8300Options> = {}, files: Record<string, string> = {}) {
  const source = memoryFileSource({ "form-8300-log.csv": LOG, "old-form-8300-2019.csv": OLD_LOG, "notes.txt": "x", ...files }, EXPORTED);
  return fincen8300Connector({ source, now: NOW, batchSize: 3, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as Form8300Event[]);
const readable = async (c = connector()) => (await eventsOf(c)).filter((e) => e.occurredAt !== undefined);

describe("reading the Form 8300 log", () => {
  it("reads BSA E-Filing's statuses, treats blank as submitted, and nothing else", () => {
    expect(filingStatus("Accepted")).toBe("accepted");
    expect(filingStatus("ACCEPTED WITH WARNINGS")).toBe("accepted_with_warnings");
    expect(filingStatus("accepted-with-warnings")).toBe("accepted_with_warnings");
    expect(filingStatus("Rejected")).toBe("rejected");
    expect(filingStatus("Filed")).toBe("submitted");
    expect(filingStatus("pending")).toBe("submitted");
    expect(filingStatus("")).toBe("submitted");
    expect(filingStatus(undefined)).toBe("submitted");
    expect(filingStatus("Lost")).toBeNull();
    expect(filingStatus("not accepted")).toBe("accepted");
  });

  it("reads one or more sale ids, and no free text", () => {
    expect(saleIdList("TEST-S-1")).toEqual(["TEST-S-1"]);
    expect(saleIdList("TEST-S-1, TEST-S-2;TEST-S-1 TEST-S-3")).toEqual(["TEST-S-1", "TEST-S-2", "TEST-S-3"]);
    expect(saleIdList("INV#204/7")).toEqual(["INV#204/7"]);
    expect(saleIdList("cash for ring!")).toBeNull();
    expect(saleIdList(" , ")).toBeNull();
    expect(saleIdList("x".repeat(65))).toBeNull();
  });

  it("reads only CSV files, not hidden ones", () => {
    expect(isFilingsLog("form-8300.csv")).toBe(true);
    expect(isFilingsLog("LOG.CSV")).toBe(true);
    expect(isFilingsLog("form-8300.xlsx")).toBe(false);
    expect(isFilingsLog(".~lock.form-8300.csv")).toBe(false);
  });
});

describe("Form 8300 filings", () => {
  it("records an acknowledged filing with its BSA ID, sales, cash and statement", async () => {
    const [first] = await readable();
    expect(first).toEqual({
      id: first!.idempotencyKey,
      type: FILING_EVENT_TYPE,
      occurredAt: "2026-01-12T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^fincen_8300:filing:31000000123457:[0-9a-f]{12}$/),
      payload: {
        system: "FinCEN BSA E-Filing",
        filingId: "31000000123457",
        filedOn: "2026-01-12",
        cashReceivedOn: "2026-01-05",
        saleIds: ["TEST-S-1001"],
        cashCents: 1_240_000,
        status: "accepted",
        daysToFile: 7,
        statusLabel: "Accepted",
        bsaId: "31000000123457",
        trackingId: "7700123",
        customerId: "TEST-C-1",
        statementSentOn: "2026-01-20",
        sourceRow: "form-8300-log.csv:2",
      },
    });
  });

  it("names a filing by its tracking ID before it has a BSA ID, and by its sales when it has neither", async () => {
    const events = await readable();
    expect(events.map((e) => [e.payload.filingId, e.payload.status, e.payload.saleIds, e.payload.daysToFile])).toEqual([
      ["31000000123457", "accepted", ["TEST-S-1001"], 7],
      ["7700124", "submitted", ["TEST-S-1002", "TEST-S-1003"], 12],
      ["7700125", "rejected", ["TEST-S-1004"], 15],
      ["TEST-S-1005@2026-01-28", "accepted_with_warnings", ["TEST-S-1005"], 4],
      ["TEST-S-1006@2026-01-29", "submitted", ["TEST-S-1006"], 4],
    ]);
    // A blank status is a filing not yet acknowledged, and keeps no label.
    expect(events[4]!.payload).not.toHaveProperty("statusLabel");
    expect(events[4]!.payload).not.toHaveProperty("customerId");
    expect(events[4]!.payload).not.toHaveProperty("statementSentOn");
    // A filing made voluntarily for a suspicious transaction says so; the others don't carry the flag.
    expect(events.map((e) => e.payload.suspicious)).toEqual([undefined, undefined, undefined, undefined, true]);
  });

  it("dead-letters a row it can't read, naming every problem", async () => {
    const bad = (await eventsOf()).filter((e) => e.occurredAt === undefined);
    expect(bad.map((e) => [e.payload.sourceRow, e.payload.problems])).toEqual([
      ["form-8300-log.csv:7", ["filed before the cash was received"]],
      [
        "form-8300-log.csv:8",
        [
          "no date cash was received",
          'cash amount "abc" is not an amount of money',
          'status "Lost" is not a BSA E-Filing status',
          'BSA ID "123" is not 14 digits',
          'BSA Tracking ID "12" is not 6 to 20 digits',
          'statement date "02/30/2026" is not a date',
          'suspicious "maybe" is not yes or no',
        ],
      ],
    ]);
    expect(bad[0]).toMatchObject({ type: FILING_EVENT_TYPE, idempotencyKey: "fincen_8300:unreadable:form-8300-log.csv:7" });
  });

  it("names a missing sale, a zero amount and a tracking ID that isn't digits", async () => {
    const text = "Filed On,Cash Received On,Sale IDs,Cash Amount,Tracking ID,BSA ID\n01/12/2026,01/05/2026,,$0.00,TRACK-1,\n01/12/2026,01/05/2026,sold the ring!,,,310000001234570";
    const events = await eventsOf(connector({}, { "form-8300-log.csv": text }));
    expect(events.map((e) => e.payload.problems)).toEqual([
      ["no sale", 'cash amount "$0.00" is not an amount of money', 'BSA Tracking ID "TRACK-1" is not 6 to 20 digits'],
      ['sales "sold the ring!" are not sale ids', "no cash amount", 'BSA ID "310000001234570" is not 14 digits'],
    ]);
  });

  it("reads day-first dates when told to", async () => {
    const text = "Filed On,Cash Received On,Sale IDs,Cash Amount\n12/01/2026,05/01/2026,TEST-S-2001,\"$10,500.00\"";
    const [event] = (await eventsOf(connector({ dateOrder: "dmy" }, { "form-8300-log.csv": text }))).filter((e) => e.payload.sourceRow === "form-8300-log.csv:2");
    expect(event!.payload).toMatchObject({ filedOn: "2026-01-12", cashReceivedOn: "2026-01-05", daysToFile: 7 });
  });

  it("stores only what changed when the log is saved again", async () => {
    const source = memoryFileSource({ "form-8300-log.csv": LOG }, EXPORTED);
    const make = () => fincen8300Connector({ source, now: NOW });
    const { memory, pipeline } = testPipeline();
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 5, deadLettered: 2 });
    // FinCEN accepts the second filing and gives it a BSA ID; the row keeps its tracking ID.
    source.files["form-8300-log.csv"] = LOG.replace("7700124,,Submitted,", "7700124,31000000123465,Accepted,02/05/2026");
    expect(await runSync({ connector: make(), mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, duplicates: 4, deadLettered: 2 });
    const changed = memory.events.filter((e) => e.payload.trackingId === "7700124").map((e) => [e.payload.filingId, e.payload.status, e.payload.statementSentOn]);
    expect(changed).toEqual([
      ["7700124", "submitted", undefined],
      ["31000000123465", "accepted", "2026-02-05"],
    ]);
  });
});

describe("Form 8300 connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ LOG, OLD_LOG });
  });

  it("declares no writes, and the write gate turns every one down", async () => {
    expect(FINCEN_8300_WRITES).toEqual([]);
    expect(await assertWritesRefused(connector())).toEqual([]);
  });

  it("survives every runSync scenario, dead-lettering the rows it can't read", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 5, deadLettered: 2 } });
    // This year's 7 rows in three batches; the 2019 log, all past the history window, in one empty batch.
    expect(result.full.batches).toBe(4);
    expect(result.replay.duplicates).toBe(5);
    expect(JSON.parse(result.full.cursor!)).toEqual({ done: { "form-8300-log.csv": sha256(LOG), "old-form-8300-2019.csv": sha256(OLD_LOG) }, current: null });
  });

  it("skips filings older than the history window, unless the window is wider", async () => {
    expect((await eventsOf()).some((e) => e.payload.filingId === "TEST-S-0001@2019-02-20")).toBe(false);
    expect((await eventsOf(connector({ historyYears: 8 }))).some((e) => e.payload.filingId === "TEST-S-0001@2019-02-20")).toBe(true);
  });

  it("names the file when the log can't be read, and stops there", async () => {
    await expect(eventsOf(connector({}, { "form-8300-log.csv": "Filed On,Sale IDs\n01/12/2026,TEST-S-1" }))).rejects.toThrow(
      new Fincen8300FileError("form-8300-log.csv", "has no column for Cash Received On or Date Cash Received or Transaction Date or Payment Date, Cash Amount or Total Cash or Cash Received or Amount"),
    );
    await expect(eventsOf(connector({}, { "form-8300-log.csv": 'Filed On,Cash Received On,Sale IDs,Cash Amount\n"01/12/2026,x,y,z' }))).rejects.toThrow(
      new Fincen8300FileError("form-8300-log.csv", "CSV line 2: a quoted field is never closed"),
    );
  });

  it("rejects bad options", () => {
    expect(() => connector({ batchSize: 0 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector({ historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
  });

  it("checks the checkpoint it resumes from", () => {
    expect(parseFincen8300Cursor(null)).toBeNull();
    expect(() => parseFincen8300Cursor('{"done":[1]}')).toThrow("Form 8300 import checkpoint is not in the expected shape");
  });
});
