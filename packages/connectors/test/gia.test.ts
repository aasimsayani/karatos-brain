import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, giaDiamondReport, giaDocMock, GIA_SANDBOX_NUMBERS, testPipeline, type GiaMock, type GiaMockData } from "@karatos/connector-testkit";
import {
  GIA_QUERIES,
  GIA_WRITES,
  GiaApiError,
  GiaConfigError,
  GiaQuotaError,
  giaApiUrl,
  giaCarats,
  giaClient,
  giaConnector,
  giaReportDate,
  giaReportNumbersFromFile,
  parseGiaCursor,
  parseReportNumbers,
  GIA_REPORT_NUMBER,
  type GiaCursor,
  type GiaEvent,
  type GiaOptions,
} from "../src/index.js";

/** A sandbox-style number for the lab-grown fixture; GIA's own lab-grown sandbox numbers read like phone numbers to the synthetic-data check. */
const LAB_NO = "2141438177";
const NOW = () => new Date("2026-01-10T00:00:00Z");
const RECEIVED = "2026-01-10T00:00:00.000Z";
const URL_ = "https://api.reportresults.gia.edu";
// Shaped like a GIA API key, assembled so no scanner mistakes it for a real one.
const KEY = ["test", "gia", "0".repeat(24)].join("-");
const noSleep = async () => {};

const NATURAL = giaDiamondReport.one({ report_number: GIA_SANDBOX_NUMBERS.naturalGrading });
const LAB = giaDiamondReport.one({
  report_number: LAB_NO,
  report_type: "Laboratory-Grown Diamond Report",
  report_type_code: "LGDR",
  report_date_iso: null,
  report_date: "June 2, 2025",
  is_digital: true,
  info_message: "This report has been reissued.",
  results: { __typename: "LabGrownDiamondGradingReportResults", identification: "Laboratory-Grown", shape_and_cutting_style: "Oval Brilliant", measurements: "8.10 x 6.02 x 3.70 mm", carat_weight: "1.50 carats", color_grade: "E", clarity_grade: "VVS2", cut_grade: null, proportions: null },
  assets: [{ asset_type_code: "PDF", asset_type_description: "Report PDF", link: "https://example.test/gia/lab.pdf" }],
});
const PEARL = { report_number: GIA_SANDBOX_NUMBERS.pearl, report_date_iso: "2025-01-02", report_type: "Pearl Identification Report", results: { __typename: "PearlIdentReportResults" }, assets: null };

const data = (extra: Partial<GiaMockData> = {}): GiaMockData => ({
  apiKey: KEY,
  reports: { [NATURAL.report_number as string]: NATURAL, [LAB.report_number as string]: LAB, [PEARL.report_number]: PEARL },
  problems: { "2141438170": "not_found", "2141438175": "forbidden", "2141438174": "in_house" },
  ...extra,
});

const LIST = [GIA_SANDBOX_NUMBERS.naturalGrading, LAB_NO, GIA_SANDBOX_NUMBERS.pearl, "2141438170", "2141438175", "2141438174"];

function connector(mock: GiaMock = giaDocMock(data()), extra: Partial<GiaOptions> = {}) {
  return giaConnector({ apiUrl: URL_, apiKey: KEY, fetch: mock.fetch, sleep: noSleep, reportNumbers: async () => LIST, batchSize: 2, now: NOW, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector(), cursor: string | null = null) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as GiaEvent[]);

describe("GIA client", () => {
  it("sends only its two read queries, with the key itself in Authorization", async () => {
    const mock = giaDocMock(data());
    const client = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: mock.fetch });
    await client.report(GIA_SANDBOX_NUMBERS.naturalGrading);
    await client.changes(null);
    expect(mock.operations).toEqual([`getReport:${GIA_SANDBOX_NUMBERS.naturalGrading}`, "getChangedReports:"]);
    expect(mock.fetch.calls).toEqual([
      { method: "POST", url: `${URL_}/` },
      { method: "POST", url: `${URL_}/` },
    ]);
    for (const query of Object.values(GIA_QUERIES)) {
      expect(query).toMatch(/^query /);
      expect(query).not.toMatch(/mutation|clearChangedReports|\blinks\b|\blink\b|quota/);
    }
  });

  it("reads a report, and tells not found, not permitted and at GIA for service apart", async () => {
    const client = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: giaDocMock(data()).fetch });
    expect(await client.report(GIA_SANDBOX_NUMBERS.naturalGrading)).toMatchObject({ kind: "found", report: { report_number: GIA_SANDBOX_NUMBERS.naturalGrading } });
    expect(await client.report("2141438170")).toEqual({ kind: "unavailable", reason: "not_found" });
    expect(await client.report("2141438175")).toEqual({ kind: "unavailable", reason: "not_permitted" });
    expect(await client.report("2141438174")).toEqual({ kind: "in_service" });
  });

  it("reads an empty answer as not found, and other GraphQL errors as errors", async () => {
    const answer = (body: unknown) => giaClient({ apiUrl: URL_, apiKey: KEY, fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
    expect(await answer({ data: { getReport: [] } }).report("2141438169")).toEqual({ kind: "unavailable", reason: "not_found" });
    expect(await answer({ data: { getReport: null } }).report("2141438169")).toEqual({ kind: "unavailable", reason: "not_found" });
    expect(await answer({ data: { getReport: { report_number: "2141438169" } } }).report("2141438169")).toMatchObject({ kind: "found" });
    await expect(answer({ errors: [{ errorType: "ARGUMENT ERROR", errorInfo: "x", message: "m" }] }).report("2141438169")).rejects.toMatchObject({ name: "GiaApiError", code: "ARGUMENT ERROR" });
    await expect(answer({ errors: [{}] }).report("2141438169")).rejects.toThrow(/could not read report 2141438169: error/);
    await expect(answer({ errors: [{ errorType: "BOOM" }] }).changes(null)).rejects.toMatchObject({ code: "BOOM" });
    await expect(answer({ errors: [{}] }).changes(null)).rejects.toThrow(/could not list changed reports: error/);
    await expect(answer([1]).report("2141438169")).rejects.toThrow(/unexpected body/);
    await expect(answer(null).report("2141438169")).rejects.toThrow(/unexpected body/);
    const notJson = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: async () => new Response("<html>", { status: 200 }) });
    await expect(notJson.report("2141438169")).rejects.toThrow(/isn't JSON/);
  });

  it("stops on a used-up quota with an error saying so", async () => {
    const client = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: giaDocMock(data({ quota: 0 })).fetch });
    const error = await client.report(GIA_SANDBOX_NUMBERS.naturalGrading).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GiaQuotaError);
    expect(error).toBeInstanceOf(GiaApiError);
    expect((error as Error).message).toMatch(/quota reached/);
  });

  it("answers a wrong key with a clear error that never shows the key", async () => {
    const other = ["test", "gia", "1".repeat(24)].join("-");
    const client = giaClient({ apiUrl: URL_, apiKey: other, fetch: giaDocMock(data()).fetch });
    const error = (await client.report(GIA_SANDBOX_NUMBERS.naturalGrading).catch((e: unknown) => e)) as GiaApiError;
    expect(error).toMatchObject({ name: "GiaApiError", status: 403, code: "AUTHORIZATION_DENIED" });
    expect(error.message).not.toContain(other);
    const other500 = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: async () => new Response("", { status: 502 }) });
    await expect(other500.report("2141438169")).rejects.toMatchObject({ status: 502, message: "GIA answered HTTP 502" });
  });

  it("waits out a 429 as Retry-After says, capped, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const mock = giaDocMock(data({ throttle: 2 }));
    const client = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: mock.fetch, sleep });
    expect(await client.report(GIA_SANDBOX_NUMBERS.naturalGrading)).toMatchObject({ kind: "found" });
    expect(waits).toEqual([2000, 2000]);
    const responses = [new Response("", { status: 429, headers: { "retry-after": "999" } }), new Response("", { status: 429 }), new Response("", { status: 429 })];
    const capped = giaClient({ apiUrl: URL_, apiKey: KEY, sleep, rateLimitRetries: 2, fetch: async () => responses.shift()! });
    waits.length = 0;
    await expect(capped.report("2141438169")).rejects.toMatchObject({ status: 429 });
    expect(waits).toEqual([60_000, 2000]);
  });

  it("sends the key to an https gia.edu address only, and checks every value before sending", async () => {
    expect(giaApiUrl("https://api.reportresults.gia.edu/graphql").pathname).toBe("/graphql");
    expect(giaApiUrl("https://gia.edu").hostname).toBe("gia.edu");
    for (const bad of ["http://api.reportresults.gia.edu", "https://api.reportresults.gia.edu.example.test", "https://notgia.edu", "https://user:pw@api.gia.edu", "https://api.gia.edu:8443", "https://api.gia.edu/?x=1", "https://api.gia.edu/#x", "not a url"]) {
      expect(() => giaApiUrl(bad), bad).toThrow(GiaConfigError);
    }
    expect(() => giaClient({ apiUrl: URL_, apiKey: "short" })).toThrow(/GIA_API_KEY/);
    expect(() => giaClient({ apiUrl: URL_, apiKey: "has a space in it" })).toThrow(/GIA_API_KEY/);
    const sent: string[] = [];
    const client = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: async (u) => (sent.push(String(u)), new Response("{}")) });
    for (const bad of ["2141", "2141438169' OR 1", "../2141438169", "a2141438169", "1234567890123"]) await expect(client.report(bad), bad).rejects.toThrow(GiaConfigError);
    await expect(client.changes("bad cursor with spaces")).rejects.toThrow(/cursor/);
    expect(sent).toEqual([]);
    expect(GIA_REPORT_NUMBER.test(GIA_SANDBOX_NUMBERS.jewelryCard)).toBe(true);
  });

  it("reads every changed report on a page, and no cursor when the feed has none", async () => {
    const mock = giaDocMock(data({ changes: { "": { reports: [NATURAL, LAB], endCursor: "c1" } } }));
    const client = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: mock.fetch });
    expect(await client.changes(null)).toMatchObject({ reports: [NATURAL, LAB], endCursor: "c1" });
    expect(await client.changes("c1")).toEqual({ reports: [], endCursor: null });
    const odd = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: async () => new Response(JSON.stringify({ data: { getChangedReports: [{ results: [{ report: null }, {}], endCursor: "" }] } })) });
    expect(await odd.changes(null)).toEqual({ reports: [], endCursor: null });
    const none = giaClient({ apiUrl: URL_, apiKey: KEY, fetch: async () => new Response(JSON.stringify({ data: {} })) });
    expect(await none.changes(null)).toEqual({ reports: [], endCursor: null });
  });
});

describe("GIA values", () => {
  it("reads carat weights and report dates, returning null rather than guessing", () => {
    expect(giaCarats("1.01 carat")).toBe(1.01);
    expect(giaCarats("1.50 carats")).toBe(1.5);
    expect(giaCarats("0.50 ct")).toBe(0.5);
    expect(giaCarats("2 Cts.")).toBe(2);
    for (const bad of [null, "", "about one carat", "1.01 grams", 1.01]) expect(giaCarats(bad), String(bad)).toBeNull();
    expect(giaReportDate({ report_date_iso: "2025-03-13" })).toBe("2025-03-13T00:00:00.000Z");
    expect(giaReportDate({ report_date_iso: "2025-03-13T10:00:00Z" })).toBe("2025-03-13T00:00:00.000Z");
    expect(giaReportDate({ report_date_iso: "2025-02-30" })).toBeNull();
    expect(giaReportDate({ report_date: "June 2, 2025" })).toBe("2025-06-02T00:00:00.000Z");
    expect(giaReportDate({ report_date_iso: "", report_date: "June 2, 2025" })).toBe("2025-06-02T00:00:00.000Z");
    for (const bad of [{}, { report_date: "Smarch 2, 2025" }, { report_date: "2/6/2025" }, { report_date: 20250602 }]) expect(giaReportDate(bad), JSON.stringify(bad)).toBeNull();
  });

  it("reads a report number list, skipping blanks and comments, and names bad lines without their contents", async () => {
    expect(parseReportNumbers("\uFEFF# certificates\n2141438169\n\n 5202397873 ,Oval\r\n\"an384\"\n2141438169\n", GIA_REPORT_NUMBER)).toEqual(["2141438169", "5202397873", "AN384"]);
    expect(() => parseReportNumbers("Report number\n2141438169\nsecret-ish value\n", GIA_REPORT_NUMBER)).toThrow("report number list: line 1, 3 are not a report number");
    expect(() => parseReportNumbers("x\n", GIA_REPORT_NUMBER)).toThrow("report number list: line 1 is not a report number");
    const many = Array.from({ length: 12 }, () => "x").join("\n");
    expect(() => parseReportNumbers(many, GIA_REPORT_NUMBER)).toThrow(/line 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 and more are not/);
    try {
      parseReportNumbers("secret-ish value\n", GIA_REPORT_NUMBER);
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
    const read = async (path: string) => (path === "/list.txt" ? "2141438169\n" : "");
    expect(await giaReportNumbersFromFile("/list.txt", read)()).toEqual(["2141438169"]);
  });
});

describe("GIA connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(data());
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), expected: { ingested: 5 } });
    // Six numbers in batches of two; the one at GIA for service is left for later.
    expect(result.full.batches).toBe(3);
    expect(result.replay.duplicates).toBe(5);
    const cursor = JSON.parse(result.full.cursor!) as GiaCursor;
    expect(cursor).toEqual({ looked: [GIA_SANDBOX_NUMBERS.naturalGrading, "2141438170", "2141438175", GIA_SANDBOX_NUMBERS.pearl, LAB_NO].sort(), changes: null });
  });

  it("records a natural diamond's grades, measurements and proportions, and which assets exist, without their links", async () => {
    const [natural] = await eventsOf();
    expect(natural).toEqual({
      id: expect.stringMatching(/^gia_report:2141438169:[0-9a-f]{12}$/),
      type: "grading.report_retrieved",
      occurredAt: "2025-03-13T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^gia:report:2141438169:[0-9a-f]{12}$/),
      payload: {
        lab: "GIA",
        reportNumber: "2141438169",
        reportType: "Diamond Grading Report",
        reportTypeCode: "DER",
        kind: "natural_diamond",
        digital: false,
        shape: "Round Brilliant",
        measurements: "6.42 - 6.45 x 3.98 mm",
        caratWeight: 1.01,
        color: "G",
        colorOrigin: undefined,
        clarity: "VS1",
        cut: "Excellent",
        polish: "Excellent",
        symmetry: "Very Good",
        fluorescence: "None",
        inscriptions: "GIA 2141438161",
        comments: "Synthetic test report.",
        countryOfOrigin: undefined,
        diamondType: undefined,
        labGrownIdentification: undefined,
        proportions: { depthPct: "61.8", tablePct: "57", crownAngle: "34.5", crownHeight: "15.0", pavilionAngle: "40.8", pavilionDepth: "43.0", starLength: "50", lowerHalf: "75", girdle: "Medium to Slightly Thick", girdleCondition: "Faceted", culet: "None" },
        assets: [
          { code: "PDF", description: "Report PDF" },
          { code: "PROPORTIONS_DIAGRAM", description: "Proportions Diagram" },
        ],
        note: undefined,
      },
    });
    expect(JSON.stringify(natural)).not.toContain("https://");
  });

  it("records lab-grown and other report kinds, and dates a report by its written date when the ISO one is missing", async () => {
    const events = await eventsOf();
    const lab = events.find((e) => e.payload.reportNumber === LAB_NO)!;
    expect(lab.occurredAt).toBe("2025-06-02T00:00:00.000Z");
    expect(lab.payload).toMatchObject({ kind: "lab_grown_diamond", digital: true, labGrownIdentification: "Laboratory-Grown", caratWeight: 1.5, cut: undefined, proportions: undefined, note: "This report has been reissued." });
    const pearl = events.find((e) => e.payload.reportNumber === GIA_SANDBOX_NUMBERS.pearl)!;
    expect(pearl.payload).toMatchObject({ kind: "pearl", shape: undefined, caratWeight: null, assets: [] });
    const odd = (await eventsOf(connector(giaDocMock(data({ reports: { "2141438169": { report_number: "2141438169", report_date_iso: "2025-01-01", results: { __typename: "Mystery" }, assets: [{ asset_type_description: "no code" }], proportions: {} } } })), { reportNumbers: async () => ["2141438169"] })))[0]!;
    expect(odd.payload).toMatchObject({ kind: "other", assets: [] });
    const jewelry = (await eventsOf(connector(giaDocMock(data({ reports: { AN384: { report_number: "AN384", report_date_iso: "2025-01-01", results: { __typename: "JewelryGradingReportResults" } } } })), { reportNumbers: async () => ["AN384"] })))[0]!;
    expect(jewelry.payload).toMatchObject({ reportNumber: "AN384", kind: "jewelry" });
    const bare = (await eventsOf(connector(giaDocMock(data({ reports: { "2141438169": { report_number: "2141438169", report_date_iso: "2025-01-01", results: { proportions: { culet: "  " } } } } })), { reportNumbers: async () => ["2141438169"] })))[0]!;
    expect(bare.payload).toMatchObject({ kind: "other", proportions: undefined });
  });

  it("records a number GIA can't confirm once, and looks up a report at GIA for service again on the next sync", async () => {
    const mock = giaDocMock(data());
    const { memory, pipeline } = testPipeline();
    const sync = () => runSync({ connector: connector(mock), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 5 });
    const unavailable = memory.events.filter((e) => e.type === "grading.report_unavailable").map((e) => [e.payload.reportNumber, e.payload.reason, e.occurredAt]);
    expect(unavailable).toEqual([
      ["2141438170", "not_found", RECEIVED],
      ["2141438175", "not_permitted", RECEIVED],
    ]);
    mock.operations.length = 0;
    expect(await sync()).toMatchObject({ ingested: 0 });
    expect(mock.operations).toEqual(["getReport:2141438174", "getChangedReports:"]);
    // Read again from scratch a day later, as after a lost checkpoint: nothing new is recorded.
    const later = connector(mock, { now: () => new Date("2026-01-11T00:00:00Z") });
    expect(await runSync({ connector: later, mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 5 });
  });

  it("dead-letters a report with no readable date or number, keeping it", async () => {
    const reports = { "2141438169": { ...NATURAL, report_date_iso: "soon", report_date: null }, "2141438171": { ...NATURAL, report_number: "" } };
    const { memory, pipeline } = testPipeline();
    const report = await runSync({ connector: connector(giaDocMock(data({ reports })), { reportNumbers: async () => ["2141438169", "2141438171"] }), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 2 });
    expect(memory.deadLetters.map((d) => d.issues.map((i) => i.path))).toEqual([["occurredAt"], ["occurredAt"]]);
  });

  it("looks a number up only once, however many syncs run, and only the new ones when the list grows", async () => {
    const mock = giaDocMock(data());
    let list: string[] = [GIA_SANDBOX_NUMBERS.naturalGrading];
    const c = connector(mock, { reportNumbers: async () => list });
    const first = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }));
    const cursor = first[first.length - 1]!.cursor;
    list = [GIA_SANDBOX_NUMBERS.naturalGrading, LAB_NO];
    mock.operations.length = 0;
    const second = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor }))).flatMap((b) => b.events as GiaEvent[]);
    expect(second.map((e) => e.payload.reportNumber)).toEqual([LAB_NO]);
    expect(mock.operations).toEqual([`getReport:${LAB_NO}`, "getChangedReports:"]);
  });

  it("stops at maxLookups, leaving the rest for the next sync", async () => {
    const mock = giaDocMock(data());
    const c = connector(mock, { maxLookups: 2 });
    const batches = await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(mock.operations.filter((o) => o.startsWith("getReport"))).toHaveLength(2);
    mock.operations.length = 0;
    await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: batches[batches.length - 1]!.cursor }));
    expect(mock.operations.filter((o) => o.startsWith("getReport"))).toEqual([`getReport:${GIA_SANDBOX_NUMBERS.pearl}`, "getReport:2141438170"]);
    expect(() => connector(mock, { maxLookups: 0 })).toThrow(/maxLookups/);
    expect(() => connector(mock, { batchSize: 1.5 })).toThrow(/batchSize/);
  });

  it("follows the changed-reports feed page by page, storing an updated report as new and an unchanged one as a duplicate", async () => {
    const updated = { ...NATURAL, results: { ...(NATURAL.results as object), clarity_grade: "VS2" } };
    const mock = giaDocMock(
      data({
        changes: {
          "": { reports: [NATURAL], endCursor: "c1" },
          c1: { reports: [updated], endCursor: "c2" },
          c2: { reports: [], endCursor: "c2" },
        },
      }),
    );
    const { memory, pipeline } = testPipeline();
    const c = connector(mock, { reportNumbers: async () => [GIA_SANDBOX_NUMBERS.naturalGrading] });
    const report = await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    // The lookup, then the feed: the same report (a duplicate), then its update.
    expect(report).toMatchObject({ ingested: 2, duplicates: 1 });
    expect(memory.events.map((e) => e.payload.clarity)).toEqual(["VS1", "VS2"]);
    expect(mock.operations).toEqual([`getReport:${GIA_SANDBOX_NUMBERS.naturalGrading}`, "getChangedReports:", "getChangedReports:c1", "getChangedReports:c2"]);
    expect(JSON.parse((await memory.getCheckpoint(TEST_ORG, "gia", "incremental"))!)).toMatchObject({ changes: "c2" });
  });

  it("stops reading the feed when the cursor doesn't move, and keeps the last cursor when the feed ends without one", async () => {
    const stuck = giaDocMock(data({ changes: { "": { reports: [NATURAL], endCursor: null } } }));
    const c = connector(stuck, { reportNumbers: async () => [] });
    const batches = await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ looked: [], changes: null }) }));
    expect(batches).toHaveLength(1);
    expect(JSON.parse(batches[0]!.cursor)).toEqual({ looked: [], changes: null });
    const kept = giaDocMock(data({ changes: { c9: { reports: [LAB], endCursor: null } } }));
    const again = await collect(connector(kept, { reportNumbers: async () => [] }).incrementalSync({ organizationId: TEST_ORG, cursor: JSON.stringify({ looked: [], changes: "c9" }) }));
    expect(JSON.parse(again[0]!.cursor)).toEqual({ looked: [], changes: "c9" });
    expect(kept.operations).toEqual(["getChangedReports:c9"]);
  });

  it("stops the sync on a used-up quota, keeping what was already looked up", async () => {
    const mock = giaDocMock(data({ quota: 1 }));
    const { memory, pipeline } = testPipeline();
    await expect(runSync({ connector: connector(mock), mode: "historical", pipeline, memory, organizationId: TEST_ORG, attempts: 1 })).rejects.toBeInstanceOf(GiaQuotaError);
    expect(memory.events.map((e) => e.payload.reportNumber)).toEqual([]);
    expect(mock.operations.slice(0, 2)).toEqual([`getReport:${GIA_SANDBOX_NUMBERS.naturalGrading}`, `getReport:${LAB_NO}`]);
  });

  it("runs the same way incrementally, takes no webhooks, and declares no writes", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("gia");
    expect(c.handleWebhook).toBeUndefined();
    expect(c.writes).toBe(GIA_WRITES);
    expect(await assertWritesRefused(c)).toEqual([]);
    expect(giaConnector({ apiUrl: URL_, apiKey: KEY, reportNumbers: async () => [] }).source).toBe("gia");
  });

  it("rejects a checkpoint it didn't write", () => {
    expect(parseGiaCursor(null)).toBeNull();
    expect(parseGiaCursor(JSON.stringify({ looked: ["2141438169"], changes: "c1" }))).toEqual({ looked: ["2141438169"], changes: "c1" });
    for (const bad of ["null", "{}", JSON.stringify({ looked: "2141438169", changes: null }), JSON.stringify({ looked: ["../x"], changes: null }), JSON.stringify({ looked: [], changes: 5 })]) {
      expect(() => parseGiaCursor(bad), bad).toThrow(/GIA checkpoint is not in the expected shape/);
    }
  });
});
