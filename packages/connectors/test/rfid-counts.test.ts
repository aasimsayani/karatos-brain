import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  MAX_TAGS_PER_COUNT,
  RFID_COUNTS_WRITES,
  RfidCountsFileError,
  TRAY_COUNT_EVENT_TYPE,
  isCountExport,
  memoryFileSource,
  parseRfidCountsCursor,
  rfidCountsConnector,
  sha256,
  tagStatus,
  type RfidCountsOptions,
  type TrayCountEvent,
} from "../src/index.js";

const NOW = () => new Date("2026-11-10T12:00:00Z");
const RECEIVED = "2026-11-10T12:00:00.000Z";
const EXPORTED = "2026-11-10T03:00:00.000Z";
const EPC = (n: number) => `E28011606000020800${String(n).padStart(6, "0")}`;

/** A night's count as RFID software exports it: one row per read, with what it expected in each tray. */
const COUNT = [
  "Session ID,Tray,Tag,SKU,Scanned At,Staff,Status",
  `TEST-SES-1,Tray A1,${EPC(1)},TEST-R-100,11/09/2026 21:00:05,TEST-STAFF-1,Found`,
  `TEST-SES-1,Tray A1,${EPC(1)},TEST-R-100,11/09/2026 21:00:07,TEST-STAFF-1,Found`,
  `TEST-SES-1,Tray A1,${EPC(2)},TEST-R-101,11/09/2026 21:01:30,TEST-STAFF-1,OK`,
  `TEST-SES-1,Tray A1,${EPC(3)},TEST-R-102,,TEST-STAFF-1,Missing`,
  `TEST-SES-1,Tray A1,${EPC(4)},TEST-N-200,11/09/2026 21:02:00,TEST-STAFF-3,Wrong tray`,
  "TEST-SES-2,Case 3,TEST-BC-5002,,11/09/2026 21:12:00,TEST-STAFF-2,",
  "TEST-SES-2,Case 3,TEST-BC-5001,,11/09/2026 21:10:00,TEST-STAFF-2,",
  ",,,,,,",
  `TEST-SES-3,Tray B2,${EPC(9)},,11/09/2026 21:20:00,,Found`,
  "TEST-SES-3,Tray B2,bad tag!,,someday,,Sold",
  "TEST-SES-4,,TEST-BC-1,,11/09/2026 21:30:00,,",
].join("\r\n");

/** A plain barcode export with no session, SKU, staff or status. */
const PLAIN = ["Tray,Barcode,Timestamp", "Tray A1,TEST-BC-0001,2026-11-08 21:00", "Tray A1,TEST-BC-0002,2026-11-08 21:05", "Tray C4,TEST-BC-0003,2026-11-08 21:07"].join("\n");

const OLD = "Tray,Tag,Scanned At\nTray A1,TEST-BC-0001,2023-06-01 21:00";

function connector(options: Partial<RfidCountsOptions> = {}, files: Record<string, string> = {}) {
  const source = memoryFileSource({ "count-2026-11-09.csv": COUNT, "count-2026-11-08.txt": PLAIN, "old-count-2023.csv": OLD, "readme.pdf": "x", ...files }, EXPORTED);
  return rfidCountsConnector({ source, now: NOW, batchSize: 2, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as TrayCountEvent[]);
const readable = async (c = connector()) => (await eventsOf(c)).filter((e) => e.occurredAt !== undefined);
const only = (text: string, options: Partial<RfidCountsOptions> = {}) => eventsOf(rfidCountsConnector({ source: memoryFileSource({ "count.csv": text }, EXPORTED), now: NOW, ...options }));

describe("reading count exports", () => {
  it("reads found, missing and wrong-tray statuses, treats blank as found, and nothing else", () => {
    expect(tagStatus("Found")).toBe("found");
    expect(tagStatus("OK")).toBe("found");
    expect(tagStatus("scanned")).toBe("found");
    expect(tagStatus("")).toBe("found");
    expect(tagStatus(undefined)).toBe("found");
    expect(tagStatus("Missing")).toBe("missing");
    expect(tagStatus("NOT FOUND")).toBe("missing");
    expect(tagStatus("not_read")).toBe("missing");
    expect(tagStatus("Wrong Tray")).toBe("unexpected");
    expect(tagStatus("extra")).toBe("unexpected");
    expect(tagStatus("not-expected")).toBe("unexpected");
    expect(tagStatus("Sold")).toBeNull();
    expect(tagStatus("founder")).toBeNull();
  });

  it("reads CSV and text exports, not hidden ones or other files", () => {
    expect(isCountExport("count.csv")).toBe(true);
    expect(isCountExport("COUNT.TXT")).toBe(true);
    expect(isCountExport("count.xlsx")).toBe(false);
    expect(isCountExport("count.csv.bak")).toBe(false);
    expect(isCountExport(".~lock.count.csv")).toBe(false);
  });
});

describe("tray counts", () => {
  it("records a count with what was found, missing and in the wrong tray, counting each tag once", async () => {
    const [count] = (await readable()).filter((e) => e.payload.sessionId === "TEST-SES-1");
    expect(count).toEqual({
      id: count!.idempotencyKey.replace(/ /g, "_"),
      type: TRAY_COUNT_EVENT_TYPE,
      occurredAt: "2026-11-09T21:02:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^rfid_counts:count:Tray A1:2026-11-09T21:02:00\.000Z:[0-9a-f]{16}$/),
      payload: {
        system: "RFID and barcode scans",
        tray: "Tray A1",
        sessionId: "TEST-SES-1",
        startedAt: "2026-11-09T21:00:05.000Z",
        countedAt: "2026-11-09T21:02:00.000Z",
        staff: ["TEST-STAFF-1", "TEST-STAFF-3"],
        found: [
          { tag: EPC(1), sku: "TEST-R-100" },
          { tag: EPC(2), sku: "TEST-R-101" },
        ],
        missing: [{ tag: EPC(3), sku: "TEST-R-102" }],
        unexpected: [{ tag: EPC(4), sku: "TEST-N-200" }],
        sourceRows: "count-2026-11-09.csv:2-6",
      },
    });
  });

  it("sorts tags, leaves out an empty SKU, and groups a plain export by tray", async () => {
    const events = await readable();
    expect(events.map((e) => [e.payload.tray, e.payload.sessionId, e.payload.found, e.payload.staff, e.occurredAt])).toEqual([
      ["Tray A1", undefined, [{ tag: "TEST-BC-0001" }, { tag: "TEST-BC-0002" }], [], "2026-11-08T21:05:00.000Z"],
      ["Tray C4", undefined, [{ tag: "TEST-BC-0003" }], [], "2026-11-08T21:07:00.000Z"],
      ["Tray A1", "TEST-SES-1", expect.any(Array), ["TEST-STAFF-1", "TEST-STAFF-3"], "2026-11-09T21:02:00.000Z"],
      ["Case 3", "TEST-SES-2", [{ tag: "TEST-BC-5001" }, { tag: "TEST-BC-5002" }], ["TEST-STAFF-2"], "2026-11-09T21:12:00.000Z"],
    ]);
    expect(events[0]!.payload).not.toHaveProperty("sessionId");
    expect(events[0]!.payload.found).toSatisfy((items: object[]) => items.every((i) => !("sku" in i)));
    expect(events[3]!.payload).toMatchObject({ startedAt: "2026-11-09T21:10:00.000Z", missing: [], unexpected: [] });
  });

  it("dead-letters a count with a row it can't read, and a row with no tray, naming every problem", async () => {
    const bad = (await eventsOf()).filter((e) => e.occurredAt === undefined);
    expect(bad.map((e) => [e.payload.tray, e.payload.sourceRows, e.payload.problems])).toEqual([
      ["", "count-2026-11-09.csv:12", ["line 12: no tray or case"]],
      ["Tray B2", "count-2026-11-09.csv:10,11", ['line 11: tag "bad tag!" is not an EPC or barcode', 'line 11: status "Sold" is not found, missing or unexpected', 'line 11: scan time "someday" is not a date']],
    ]);
    expect(bad[0]).toMatchObject({ type: TRAY_COUNT_EVENT_TYPE, receivedAt: RECEIVED, idempotencyKey: expect.stringMatching(/^rfid_counts:unreadable:[0-9a-f]{16}$/) });
    expect(bad[0]!.id).toBe(bad[0]!.idempotencyKey);
    expect(bad[0]!.idempotencyKey).not.toBe(bad[1]!.idempotencyKey);
    // The same bad rows saved under another name, or further down a file, have the same key.
    const copied = (await eventsOf(connector({}, { "count-2026-11-09.csv": "Tray,Tag,Scanned At", "other-name.csv": `${COUNT}\r\n,,,,,,` }))).filter((e) => e.occurredAt === undefined);
    expect(copied.map((e) => e.idempotencyKey)).toEqual(bad.map((e) => e.idempotencyKey));
  });

  it("needs a tag on every row and a time on every piece that was read", async () => {
    const events = await only("Tray,Tag,Scanned At,Status,Staff\nTray A1,,11/09/2026 21:00,,\nTray A1,TEST-BC-1,,Found,\nTray A1,TEST-BC-2,,Wrong tray,\nTray A1,TEST-BC-3,11/09/2026 21:00,,TEST\u0007STAFF");
    expect(events.map((e) => e.payload.problems)).toEqual([["line 2: no tag", "line 3: no scan time", "line 4: no scan time", "line 5: staff member is not a name or id"]]);
  });

  it("keeps a tag once, as unexpected if any read says so, else found if it was read at all", async () => {
    const text = [
      "Tray,Tag,SKU,Scanned At,Status",
      "Tray A1,TEST-BC-1,,,Missing",
      "Tray A1,TEST-BC-1,TEST-R-1,11/09/2026 21:00,Found",
      "Tray A1,TEST-BC-1,TEST-R-2,11/09/2026 21:01,Found",
      "Tray A1,TEST-BC-2,,11/09/2026 21:01,Found",
      "Tray A1,TEST-BC-2,,,Missing",
      "Tray A1,TEST-BC-3,,11/09/2026 21:02,Wrong tray",
      "Tray A1,TEST-BC-3,,11/09/2026 21:03,Found",
      "Tray A1,TEST-BC-4,,,Missing",
      "Tray A1,TEST-BC-4,,,Missing",
    ].join("\n");
    const [count] = await only(text);
    // Of two equal reads, the first is kept.
    expect(count!.payload).toMatchObject({ found: [{ tag: "TEST-BC-1", sku: "TEST-R-1" }, { tag: "TEST-BC-2" }], missing: [{ tag: "TEST-BC-4" }], unexpected: [{ tag: "TEST-BC-3" }] });
  });

  it("keeps two sessions of one tray apart, and one session's two trays apart", async () => {
    const text = "Session,Tray,Tag,Scanned At\nS1,Tray A1,TEST-BC-1,11/09/2026 21:00\nS2,Tray A1,TEST-BC-1,11/09/2026 22:00\nS1,Tray A2,TEST-BC-2,11/09/2026 21:05";
    expect((await only(text)).map((e) => [e.payload.sessionId, e.payload.tray, e.occurredAt])).toEqual([
      ["S1", "Tray A1", "2026-11-09T21:00:00.000Z"],
      ["S2", "Tray A1", "2026-11-09T22:00:00.000Z"],
      ["S1", "Tray A2", "2026-11-09T21:05:00.000Z"],
    ]);
  });

  it("trims the tray, tag and SKU", async () => {
    const [count] = await only('Tray,Tag,SKU,Scanned At\n" Tray A1 "," TEST-BC-1 "," TEST-R-1 ",11/09/2026 21:00\nTray A1,TEST-BC-1,TEST-R-1,11/09/2026 21:01');
    expect(count!.payload).toMatchObject({ tray: "Tray A1", found: [{ tag: "TEST-BC-1", sku: "TEST-R-1" }] });
    expect(count!.payload.found).toHaveLength(1);
  });

  it("times a count where nothing was read by the file", async () => {
    const [count] = await only("Tray,Tag,Scanned At,Status\nTray A1,TEST-BC-1,,Missing");
    expect(count).toMatchObject({ occurredAt: EXPORTED, payload: { startedAt: EXPORTED, countedAt: EXPORTED, found: [], missing: [{ tag: "TEST-BC-1" }] } });
  });

  it("reads day-first dates and the store's own offset when told to", async () => {
    const [count] = await only("Tray,Tag,Scanned At\nTray A1,TEST-BC-1,09/11/2026 21:00\nTray A1,TEST-BC-2,2026-11-09T21:30:00Z", { dateOrder: "dmy", utcOffset: "-05:00" });
    expect(count!.payload).toMatchObject({ startedAt: "2026-11-09T21:30:00.000Z", countedAt: "2026-11-10T02:00:00.000Z" });
  });

  it("takes up to the tag limit in one count, and dead-letters more", async () => {
    const rows = (n: number) => ["Tray,Tag,Scanned At", ...Array.from({ length: n }, (_, i) => `Tray A1,TEST-BC-${i},11/09/2026 21:00`)].join("\n");
    const [full] = await only(rows(MAX_TAGS_PER_COUNT));
    expect((full!.payload.found as unknown[]).length).toBe(MAX_TAGS_PER_COUNT);
    const [over] = await only(rows(MAX_TAGS_PER_COUNT + 1));
    expect(over).toMatchObject({ occurredAt: undefined, payload: { problems: ["more than 5000 tags in one count"] } });
  });

  it("keeps at most 50 problems for one count", async () => {
    const text = ["Tray,Tag,Scanned At", ...Array.from({ length: 60 }, () => "Tray A1,bad tag!,11/09/2026 21:00")].join("\n");
    const [bad] = await only(text);
    expect((bad!.payload.problems as string[]).length).toBe(50);
  });

  it("stores nothing new when the same export is saved again under another name, and a new count when it changes", async () => {
    const source = memoryFileSource({ "count-2026-11-09.csv": COUNT }, EXPORTED);
    const make = () => rfidCountsConnector({ source, now: NOW });
    const { memory, pipeline } = testPipeline();
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 2, deadLettered: 2 });
    source.files["count-2026-11-09 (1).csv"] = COUNT;
    expect(await runSync({ connector: make(), mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 4 });
    // The first incremental sync reads both files; after that only a changed file is read.
    // The missing piece turns up on a recount of the same session.
    source.files["count-2026-11-09 (1).csv"] = COUNT.replace(`${EPC(3)},TEST-R-102,,TEST-STAFF-1,Missing`, `${EPC(3)},TEST-R-102,11/09/2026 21:05:00,TEST-STAFF-1,Found`);
    expect(await runSync({ connector: make(), mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, duplicates: 1, deadLettered: 2 });
    expect(memory.events.filter((e) => e.payload.sessionId === "TEST-SES-1").map((e) => (e.payload.missing as unknown[]).length)).toEqual([1, 0]);
  });
});

describe("tray counts connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ COUNT, PLAIN, OLD });
  });

  it("declares no writes, and the write gate turns every one down", async () => {
    expect(RFID_COUNTS_WRITES).toEqual([]);
    expect(await assertWritesRefused(connector())).toEqual([]);
  });

  it("survives every runSync scenario, dead-lettering the counts it can't read", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 4, deadLettered: 2 } });
    // The 2023 export, past the history window, in one empty batch; the plain export's 2 counts in one; the night's 4 events in two.
    expect(result.full.batches).toBe(4);
    expect(result.replay.duplicates).toBe(4);
    expect(JSON.parse(result.full.cursor!)).toEqual({
      done: { "count-2026-11-08.txt": sha256(PLAIN), "count-2026-11-09.csv": sha256(COUNT), "old-count-2023.csv": sha256(OLD) },
      current: null,
    });
  });

  it("skips counts older than the history window, unless the window is wider", async () => {
    const old = (e: TrayCountEvent) => e.payload.countedAt === "2023-06-01T21:00:00.000Z";
    expect((await eventsOf()).some(old)).toBe(false);
    expect((await eventsOf(connector({ historyYears: 4 }))).some(old)).toBe(true);
  });

  it("names the file when an export can't be read, and stops there", async () => {
    await expect(only("Tray,SKU\nTray A1,TEST-R-1")).rejects.toThrow(
      new RfidCountsFileError("count.csv", "has no column for Tag or Tag ID or EPC or RFID or Barcode or Item Tag or Tag Number, Scanned At or Scan Time or Read Time or Timestamp or Scan Date or Date"),
    );
    await expect(only('Tray,Tag,Scanned At\n"Tray A1,x,y')).rejects.toThrow(new RfidCountsFileError("count.csv", "CSV line 2: a quoted field is never closed"));
  });

  it("rejects bad options", () => {
    expect(() => connector({ batchSize: 0 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector({ historyYears: 1.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector({ historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector({ utcOffset: "-5" })).toThrow("utcOffset must be Z or an offset such as -05:00");
    expect(() => connector({ utcOffset: "+15:00" })).toThrow("utcOffset must be Z or an offset such as -05:00");
    expect(() => connector({ utcOffset: "+14:00x" })).toThrow("utcOffset must be Z or an offset such as -05:00");
    expect(() => connector({ utcOffset: "+14:00" })).not.toThrow();
  });

  it("checks the checkpoint it resumes from", () => {
    expect(parseRfidCountsCursor(null)).toBeNull();
    expect(() => parseRfidCountsCursor('{"done":[1]}')).toThrow("Tray count import checkpoint is not in the expected shape");
  });
});
