import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, checkConnectorSync, statementPage, syntheticPdf, testPipeline } from "@karatos/connector-testkit";
import {
  BankProfileError,
  GENERIC_BANK_PROFILE,
  GENERIC_PDF_LAYOUT,
  MAX_PDF_LINE,
  PdfError,
  PdfLayoutError,
  StatementFileError,
  bankStatementsConnector,
  memoryFileSource,
  parseBankProfile,
  linesOf,
  pdfLines,
  pdfStatementLines,
  sha256,
  type BankEvent,
  type PdfLine,
} from "../src/index.js";

const NOW = () => new Date("2026-01-20T00:00:00Z");
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

// Columns as a statement prints them: date, description, amount, balance.
const D = 50;
const DESC = 110;
const AMT = 420;
const BAL = 510;

const CHECKING_PAGES = [
  statementPage([
    [[D, "Test Bank Business Checking"]],
    [[D, "Account ending 1234"]],
    [[D, "Statement Period 12/16/2025 through 01/15/2026"]],
    [[D, "Account Summary"]],
    [[D, "Beginning Balance"], [AMT, "10,000.00"]],
    [[D, "DEPOSITS AND ADDITIONS"]],
    [[D, "12/30"], [DESC, "BRANCH DEPOSIT"], [AMT, "1,250.00"]],
    [[D, "01/02"], [DESC, "STRIPE TRANSFER ST-TEST0001"], [AMT, "2,400.55"]],
    [[D, "Total Deposits and Additions"], [AMT, "3,650.55"]],
  ]),
  statementPage([
    [[D, "WITHDRAWALS"]],
    [[D, "01/05"], [DESC, "CHECK 1001"], [AMT, "500.00"]],
    [[D, "01/08"], [DESC, "ZELLE PAYMENT TO TEST VENDOR"], [AMT, "20.00"]],
    [[D, "01/08"], [DESC, "ZELLE PAYMENT TO TEST VENDOR"], [AMT, "20.00"]],
    [[D, "01/09"], [DESC, "BAD AMOUNT ROW"], [AMT, "1,2,50.00"]],
    [[D, "SERVICE FEES"]],
    [[D, "01/15"], [DESC, "MONTHLY SERVICE FEE"], [AMT, "15.00"]],
    [[D, "DAILY BALANCE"]],
    [[D, "01/02"], [DESC, "13,650.55"], [AMT, "01/05"], [BAL, "13,150.55"]],
    [[D, "01/15"], [DESC, "Ending Balance"], [AMT, "13,115.55"]],
  ]),
];
const CHECKING_PDF = syntheticPdf(CHECKING_PAGES);

const CARD_PAGES = [
  statementPage([
    [[D, "Test Card Services"]],
    [[D, "Closing Date 01/12/2026"]],
    [[D, "PAYMENTS AND OTHER CREDITS"]],
    [[D, "01/09"], [DESC, "PAYMENT THANK YOU"], [AMT, "-1,000.00"]],
    [[D, "PURCHASES"]],
    [[D, "01/04"], [DESC, "TEST SUPPLIER INC"], [AMT, "850.00"]],
  ]),
];
const CARD_PDF = syntheticPdf(CARD_PAGES);

const line = (text: string, n: number, page = 1): PdfLine => ({ page, line: n, text });
const lines = (...texts: string[]) => texts.map((t, i) => line(t, i + 1));

function connector(files: Record<string, string | Uint8Array>, card: Record<string, string | Uint8Array> = {}) {
  return bankStatementsConnector({
    accounts: [
      { id: "checking-1234", kind: "bank", source: memoryFileSource(files) },
      { id: "card-5678", kind: "credit_card", source: memoryFileSource(card) },
    ],
    now: NOW,
    batchSize: 3,
  });
}

async function eventsOf(c: ReturnType<typeof connector>): Promise<BankEvent[]> {
  const out: SourceBatch[] = [];
  for await (const page of c.historicalImport({ organizationId: TEST_ORG, cursor: null })) out.push(page);
  return out.flatMap((b) => b.events as BankEvent[]);
}

describe("PDF text lines", () => {
  it("reads each page top to bottom, keeping columns two spaces apart", async () => {
    const read = await pdfLines(CHECKING_PDF);
    expect(read.slice(0, 3).map((l) => l.text)).toEqual(["Test Bank Business Checking", "Account ending 1234", "Statement Period 12/16/2025 through 01/15/2026"]);
    expect(read.find((l) => l.text.startsWith("12/30"))).toEqual({ page: 1, line: 7, text: "12/30  BRANCH DEPOSIT  1,250.00" });
    expect(read.find((l) => l.text.startsWith("01/05"))).toMatchObject({ page: 2, line: 2 });
  });

  it("joins pieces of one word or phrase without adding columns", async () => {
    const pdf = syntheticPdf([[{ x: 50, y: 700, text: "STRIPE" }, { x: 89, y: 700.5, text: "TRANSFER" }, { x: 146, y: 700, text: "ST" }]]);
    expect((await pdfLines(pdf)).map((l) => l.text)).toEqual(["STRIPE TRANSFER ST"]);
  });

  it("spaces words, separates columns and joins split words when pdf.js hands over separate pieces", () => {
    const piece = (x: number, text: string, y = 700) => ({ x, y, width: text.length * 6, height: 10, text });
    expect(linesOf([piece(50, "STRIPE"), piece(89, "TRANSFER"), piece(300, "1.00"), piece(50, "NEXT", 686), piece(74, "LINE", 686.5)])).toEqual(["STRIPE TRANSFER  1.00", "NEXTLINE"]);
    expect(linesOf([{ x: 10, y: 5, width: 0, height: 10, text: "" }, piece(30, "A", 5)])).toEqual(["A"]);
  });

  it("trims a long run of tabs or spaces in linear time", () => {
    const piece = (x: number, text: string) => ({ x, y: 700, width: text.length * 6, height: 10, text });
    const started = performance.now();
    expect(linesOf([piece(50, `A${"\t".repeat(200_000)}x`), piece(50, " \t".repeat(100_000))])).toHaveLength(1);
    expect(linesOf([piece(50, `${" ".repeat(10)}A${"\t ".repeat(100_000)}`)])).toEqual(["A"]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("refuses files over the size or page limit, and anything that isn't a PDF", async () => {
    await expect(pdfLines(CHECKING_PDF, { maxBytes: 100 })).rejects.toThrow(new PdfError("is larger than 0 MB"));
    await expect(pdfLines(CHECKING_PDF, { maxPages: 1 })).rejects.toThrow("has 2 pages, more than the 1 allowed");
    await expect(pdfLines(new TextEncoder().encode("Date,Description,Amount\n"))).rejects.toThrow("is not a readable PDF");
    await expect(pdfLines(new TextEncoder().encode("%PDF-1.7"))).rejects.toThrow(PdfError);
  });

  it("leaves the caller's bytes untouched", async () => {
    const copy = CHECKING_PDF.slice();
    await pdfLines(copy);
    expect(copy).toEqual(CHECKING_PDF);
  });
});

describe("PDF statement lines", () => {
  it("signs amounts by section, fills in missing years from the closing date, and skips balances and totals", async () => {
    const read = pdfStatementLines(await pdfLines(CHECKING_PDF), GENERIC_BANK_PROFILE, "checking-1234/s.pdf");
    expect(read.map((l) => [l.occurredAt?.slice(0, 10), l.amountCents, l.description])).toEqual([
      ["2025-12-30", 125_000, "BRANCH DEPOSIT"],
      ["2026-01-02", 240_055, "STRIPE TRANSFER ST-TEST0001"],
      ["2026-01-05", -50_000, "CHECK 1001"],
      ["2026-01-08", -2_000, "ZELLE PAYMENT TO TEST VENDOR"],
      ["2026-01-08", -2_000, "ZELLE PAYMENT TO TEST VENDOR"],
      [undefined, null, "01/09 BAD AMOUNT ROW 1,2,50.00"],
      ["2026-01-15", -1_500, "MONTHLY SERVICE FEE"],
    ]);
    expect(read[0]!.sourceRow).toBe("checking-1234/s.pdf:p1:7");
    expect(read[5]!.sourceRow).toBe("checking-1234/s.pdf:p2:5");
  });

  it("reads card statements, where payments are credits and purchases are charges", async () => {
    const read = pdfStatementLines(await pdfLines(CARD_PDF), GENERIC_BANK_PROFILE, "card.pdf");
    expect(read.map((l) => [l.occurredAt?.slice(0, 10), l.amountCents])).toEqual([
      ["2026-01-09", 100_000],
      ["2026-01-04", -85_000],
    ]);
  });

  it("keeps amounts as written outside money-in and money-out sections, with trailing and unicode minus signs", () => {
    const read = pdfStatementLines(
      lines("Transaction History", "01/02/2026  REFUND  25.00", "01/31/2026  ENDING BALANCE  1,000.00", "01/03/2026  PURCHASE TEST  25.00-", "01/04/2026  PURCHASE TEST  −5.00", "01/05/2026  ROW  (7.50)  100.00"),
      GENERIC_BANK_PROFILE,
      "f.pdf",
    );
    expect(read.map((l) => [l.amountCents, l.balanceCents])).toEqual([
      [2_500, undefined],
      [-2_500, undefined],
      [-500, undefined],
      [-750, 10_000],
    ]);
    const outPositive = parseBankProfile({ ...GENERIC_BANK_PROFILE, amounts: "money_out_positive" });
    expect(pdfStatementLines(lines("01/03/2026  PURCHASE  25.00"), outPositive, "f.pdf")[0]!.amountCents).toBe(-2_500);
  });

  it("never runs the layout's patterns on a line longer than any statement prints", () => {
    const long = `01/02/2026 A${" ".repeat(20_000)}x`;
    const started = performance.now();
    const read = pdfStatementLines(lines(`Statement period 12/16/2025 through 01/15/2026${" ".repeat(20_000)}x`, "Deposits", long, "01/03/2026  DEPOSIT  5.00", "Daily balance", long), GENERIC_BANK_PROFILE, "f.pdf");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(read).toEqual([
      { sourceRow: "f.pdf:p1:3", occurredAt: undefined, amountCents: null, description: "01/02/2026 A " },
      { sourceRow: "f.pdf:p1:4", occurredAt: "2026-01-03T00:00:00.000Z", amountCents: 500, description: "DEPOSIT" },
    ]);
    expect(MAX_PDF_LINE).toBe(500);
    // A profile's own period pattern doesn't run on an over-long line either, so its closing date isn't used.
    expect(pdfStatementLines(lines(`${"x".repeat(MAX_PDF_LINE)} through 01/15/2026`, "Deposits", "01/03  DEPOSIT  5.00"), GENERIC_BANK_PROFILE, "f.pdf")[0]!.occurredAt).toBeUndefined();
    expect(pdfStatementLines(lines("Deposits", `01/02/2026  ${"A".repeat(MAX_PDF_LINE - 18)}  5.00`), GENERIC_BANK_PROFILE, "f.pdf")[0]!.amountCents).toBe(500);
  });

  it("dead-letters a dated line with no year when the closing date can't be found", () => {
    const read = pdfStatementLines(lines("Deposits", "01/02  DEPOSIT  5.00"), GENERIC_BANK_PROFILE, "f.pdf");
    expect(read).toEqual([{ sourceRow: "f.pdf:p1:2", occurredAt: undefined, amountCents: 500, description: "DEPOSIT" }]);
  });

  it("puts dates after the closing day in the year before, in day-first order too", () => {
    const dmy = parseBankProfile({ ...GENERIC_BANK_PROFILE, dateOrder: "dmy" });
    const read = pdfStatementLines(lines("Statement period 16/12/2025 to 15/01/2026", "Deposits", "16/01  LATE  1.00", "15/01  ON THE DAY  2.00", "31/12  YEAR END  3.00"), dmy, "f.pdf");
    expect(read.map((l) => l.occurredAt?.slice(0, 10))).toEqual(["2025-01-16", "2026-01-15", "2025-12-31"]);
  });

  it("reads a client's own layout with debit and credit columns", () => {
    const profile = parseBankProfile({
      id: "test_bank",
      name: "Test Bank",
      columns: GENERIC_BANK_PROFILE.columns,
      pdf: { transaction: String.raw`^(?<date>\d{4}-\d{2}-\d{2})\s{2,}(?<description>.+?)\s{2,}(?<debit>[\d,.]*)\s{2,}(?<credit>[\d,.]*)$` },
    });
    const read = pdfStatementLines(lines("2026-01-02  TEST DEPOSIT  0.00  10.00", "2026-01-03  TEST CHECK  4.00  0.00"), profile, "f.pdf");
    expect(read.map((l) => l.amountCents)).toEqual([1_000, -400]);
  });

  it("stops with a clear message when a PDF looks nothing like a statement it knows", () => {
    expect(() => pdfStatementLines(lines("Quarterly newsletter", "Nothing to see"), GENERIC_BANK_PROFILE, "f.pdf")).toThrow(PdfLayoutError);
    expect(pdfStatementLines(lines("Deposits", "No activity this period"), GENERIC_BANK_PROFILE, "f.pdf")).toEqual([]);
  });

  it("validates a profile's PDF layout, naming the bad field", () => {
    const base = { id: "test_bank", name: "Test Bank", columns: GENERIC_BANK_PROFILE.columns };
    expect(() => parseBankProfile({ ...base, pdf: { transaction: "^(?<date>\\S+)\\s+(?<amount>\\S+)$" } })).toThrow("pdf.transaction needs named groups for description");
    expect(() => parseBankProfile({ ...base, pdf: { transaction: "^(?<date>\\S+) (?<description>\\S+) (?<debit>\\S+)$" } })).toThrow("amount (or debit and credit)");
    expect(() => parseBankProfile({ ...base, pdf: { ...GENERIC_PDF_LAYOUT, period: "through (\\S+)" } })).toThrow("pdf.period needs a named group end");
    expect(() => parseBankProfile({ ...base, pdf: { ...GENERIC_PDF_LAYOUT, sections: [{ match: "(", amounts: "money_in" }] } })).toThrow(new BankProfileError("bank statement profile: pdf.sections.0.match is not a valid pattern"));
    expect(() => parseBankProfile({ ...base, pdf: { ...GENERIC_PDF_LAYOUT, ignore: ["["] } })).toThrow("pdf.ignore.0 is not a valid pattern");
    expect(() => parseBankProfile({ ...base, pdf: { ...GENERIC_PDF_LAYOUT, period: "(" } })).toThrow("pdf.period is not a valid pattern");
    expect(() => parseBankProfile({ ...base, pdf: { transaction: "(" } })).toThrow("pdf.transaction is not a valid pattern");
  });
});

describe("bank statements connector with PDF statements", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ checking: CHECKING_PAGES.flat().map((p) => p.text), card: CARD_PAGES.flat().map((p) => p.text) });
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({
      makeConnector: () => connector({ "statement-2026-01.pdf": CHECKING_PDF }, { "card-2026-01.PDF": CARD_PDF }),
      payloadSchemas: SCHEMAS,
      expected: { ingested: 8, deadLettered: 1 },
    });
    expect(JSON.parse(result.full.cursor!)).toEqual({
      done: { "card-5678/card-2026-01.PDF": sha256(Buffer.from(CARD_PDF).toString("latin1")), "checking-1234/statement-2026-01.pdf": sha256(Buffer.from(CHECKING_PDF).toString("latin1")) },
      current: null,
    });
  });

  it("stores a transaction once when its CSV export and PDF statement both have it", async () => {
    const csv = ["Date,Description,Amount", "01/05/2026,CHECK 1001,-500.00", "01/02/2026,STRIPE TRANSFER,2400.55", "01/16/2026,AFTER THE STATEMENT,-9.00"].join("\n");
    const files: Record<string, string | Uint8Array> = { "statement-2026-01.pdf": CHECKING_PDF };
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    expect(await runSync({ connector: connector(files), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 6, deadLettered: 1 });
    files["activity-2026-01.csv"] = csv;
    expect(await runSync({ connector: connector(files), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, duplicates: 2 });
  });

  it("gives PDF transactions the same shape and category as CSV ones", async () => {
    const events = await eventsOf(connector({ "s.pdf": CHECKING_PDF }));
    expect(events.find((e) => e.payload.description === "BRANCH DEPOSIT")).toMatchObject({
      idempotencyKey: "bank:checking-1234:2025-12-30:125000:0",
      occurredAt: "2025-12-30T00:00:00.000Z",
      payload: { accountId: "bank:checking-1234", amountCents: 125_000, category: "cash_deposit", sourceRow: "checking-1234/s.pdf:p1:7" },
    });
    expect(events.filter((e) => e.payload.description === "ZELLE PAYMENT TO TEST VENDOR").map((e) => e.idempotencyKey)).toEqual([
      "bank:checking-1234:2026-01-08:-2000:0",
      "bank:checking-1234:2026-01-08:-2000:1",
    ]);
  });

  it("names the account and file when a PDF can't be read", async () => {
    await expect(eventsOf(connector({ "broken.pdf": new TextEncoder().encode("%PDF-1.7 truncated") }))).rejects.toThrow(new StatementFileError("checking-1234/broken.pdf", "is not a readable PDF"));
    const notAStatement = syntheticPdf([statementPage([[[D, "Quarterly newsletter"]]])]);
    await expect(eventsOf(connector({ "news.pdf": notAStatement }))).rejects.toThrow("checking-1234/news.pdf: no transactions or section headings found");
  });

  it("reads a PDF from a folder on disk as bytes", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { accountsFromDirectory } = await import("../src/index.js");
    const dir = await mkdtemp(join(tmpdir(), "bank-pdf-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "checking-1234"));
    await writeFile(join(dir, "checking-1234", "statement.pdf"), CHECKING_PDF);
    const c = bankStatementsConnector({ accounts: await accountsFromDirectory(dir), now: NOW });
    const out: BankEvent[] = [];
    for await (const b of c.historicalImport({ organizationId: TEST_ORG, cursor: null })) out.push(...(b.events as BankEvent[]));
    expect(out).toHaveLength(7);
  });
});

describe("memory file sources", () => {
  it("serves text and bytes either way round, and refuses unknown or inherited names", async () => {
    const source = memoryFileSource({ "a.csv": "Date", "b.pdf": new TextEncoder().encode("%PDF") });
    expect(await source.read("b.pdf")).toBe("%PDF");
    expect(await source.readBytes("a.csv")).toEqual(new TextEncoder().encode("Date"));
    await expect(source.read("constructor")).rejects.toThrow("no file named constructor");
  });

  it("passes a failure to read a PDF's bytes through unchanged, for runSync to retry", async () => {
    const c = bankStatementsConnector({
      accounts: [{ id: "checking-1234", kind: "bank", source: { list: async () => [{ name: "s.pdf", modifiedAt: "2026-01-01T00:00:00Z" }], read: async () => "", readBytes: async () => Promise.reject(new Error("disk unplugged")) } }],
      now: NOW,
    });
    await expect(eventsOf(c as ReturnType<typeof connector>)).rejects.toThrow(/^disk unplugged$/);
  });
});

describe("syntheticPdf", () => {
  it("refuses empty documents and text it can't write", () => {
    expect(() => syntheticPdf([])).toThrow("at least one page");
    expect(() => syntheticPdf([[{ x: 1, y: 1, text: "café" }]])).toThrow("printable ASCII only");
  });

  it("escapes brackets and backslashes so the text reads back as written", async () => {
    const pdf = syntheticPdf([[{ x: 50, y: 700, text: String.raw`(25.00) a\b`, size: 12 }]]);
    expect((await pdfLines(pdf)).map((l) => l.text)).toEqual([String.raw`(25.00) a\b`]);
  });
});
