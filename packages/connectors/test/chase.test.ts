import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SourceBatch } from "@karatos/core";
import { TEST_ORG, statementPage, syntheticPdf } from "@karatos/connector-testkit";
import {
  BANK_PROFILES,
  BankProfileError,
  CHASE_CARD_PROFILE,
  CHASE_CHECKING_PROFILE,
  CHASE_IMPORT_MODES,
  GENERIC_BANK_PROFILE,
  bankStatementsConnector,
  builtInBankProfile,
  chaseAccountsFromDirectory,
  chaseConnector,
  chaseFormats,
  csvStatementLines,
  memoryFileSource,
  parseBankProfile,
  pdfLines,
  pdfStatementLines,
  resolveBankProfiles,
  type BankEvent,
  type StatementAccountSource,
} from "../src/index.js";

// Synthetic statements laid out like Chase's public formats. No real account, payee or amount.
const NOW = () => new Date("2026-01-20T00:00:00Z");
const D = 50;
const DESC = 110;
const AMT = 420;

const CHECKING_PDF = syntheticPdf([
  statementPage([
    [[D, "Test Business Complete Checking"]],
    [[D, "December 16, 2025 through January 15, 2026"]],
    [[D, "Account Number: 000000000001234"]],
    [[D, "CHECKING SUMMARY"]],
    [[D, "Beginning Balance"], [AMT, "$10,000.00"]],
    [[D, "DEPOSITS AND ADDITIONS"]],
    [[D, "12/30"], [DESC, "Remote Online Deposit 1"], [AMT, "$1,250.00"]],
    [[D, "01/02"], [DESC, "Orig CO Name:Test Payments Orig ID:0000000000"], [AMT, "2,400.55"]],
    [[D, "Total Deposits and Additions"], [AMT, "$3,650.55"]],
    [[D, "CHECKS PAID"]],
    [[D, "1001"], [DESC - 20, "^"], [DESC + 40, "01/05"], [AMT, "500.00"]],
    [[D, "1002"], [DESC + 40, "01/06"], [AMT, "75.25"]],
    [[D, "Total Checks Paid"], [AMT, "$575.25"]],
  ]),
  statementPage([
    [[D, "ELECTRONIC WITHDRAWALS"]],
    [[D, "01/08"], [DESC, "Zelle Payment To Test Vendor Jpm00000001"], [AMT, "20.00"]],
    [[D, "FEES"]],
    [[D, "01/15"], [DESC, "Monthly Service Fee"], [AMT, "15.00"]],
    [[D, "DAILY ENDING BALANCE"]],
    [[D, "01/02"], [DESC, "$13,650.55"]],
    [[D, "Ending Balance"], [AMT, "$13,060.30"]],
  ]),
]);

const CARD_PDF = syntheticPdf([
  statementPage([
    [[D, "Test Business Card"]],
    [[D, "Opening/Closing Date 12/16/25 - 01/15/26"]],
    [[D, "ACCOUNT ACTIVITY"]],
    [[D, "PAYMENTS AND OTHER CREDITS"]],
    [[D, "01/09"], [DESC, "Payment Thank You - Web"], [AMT, "-1,000.00"]],
    [[D, "PURCHASE"]],
    [[D, "12/28"], [DESC, "TEST SUPPLIER INC"], [AMT, "850.00"]],
    [[D, "01/04"], [DESC, "TEST SHIPPING CO"], [AMT, "42.10"]],
    [[D, "Total fees charged in 2026"], [AMT, "$0.00"]],
  ]),
]);

// Chase's checking download ends every row with a comma; the card download has Category and Type columns.
const CHECKING_CSV = [
  "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #,",
  "DEBIT,01/15/2026,Monthly Service Fee,-15.00,FEE_TRANSACTION,13060.30,,",
  "DEBIT,01/08/2026,Zelle Payment To Test Vendor Jpm00000001,-20.00,QUICKPAY_DEBIT,13075.30,,",
  "CHECK,01/06/2026,CHECK 1002,-75.25,CHECK_PAID,13095.30,1002,",
  "CHECK,01/05/2026,CHECK 1001,-500.00,CHECK_PAID,13170.55,1001,",
  "CREDIT,01/02/2026,Orig CO Name:Test Payments Orig ID:0000000000,2400.55,ACH_CREDIT,13650.55,,",
  "DSLIP,12/30/2025,Remote Online Deposit 1,1250.00,DEPOSIT,11250.00,1,",
  "",
].join("\n");

const CARD_CSV = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "01/09/2026,01/09/2026,Payment Thank You - Web,,Payment,1000.00,",
  "01/04/2026,01/05/2026,TEST SHIPPING CO,Shipping,Sale,-42.10,",
  "12/28/2025,12/29/2025,TEST SUPPLIER INC,Shopping,Sale,-850.00,",
  "",
].join("\n");

const summary = (lines: { occurredAt: string | undefined; amountCents: number | null; description: string }[]) =>
  lines.map((l) => [l.occurredAt?.slice(0, 10), l.amountCents, l.description]);

async function eventsOf(c: { historicalImport: (i: { organizationId: string; cursor: string | null }) => AsyncIterable<SourceBatch> }): Promise<BankEvent[]> {
  const out: SourceBatch[] = [];
  for await (const page of c.historicalImport({ organizationId: TEST_ORG, cursor: null })) out.push(page);
  return out.flatMap((b) => b.events as BankEvent[]);
}

const accounts = (checking: Record<string, string | Uint8Array>, card: Record<string, string | Uint8Array> = {}): StatementAccountSource[] => [
  { id: "checking-1234", kind: "bank", source: memoryFileSource(checking), profile: CHASE_CHECKING_PROFILE },
  { id: "card-5678", kind: "credit_card", source: memoryFileSource(card), profile: CHASE_CARD_PROFILE },
];

describe("Chase checking statements", () => {
  it("reads a PDF with a spelled-out period, checks paid by number, and skips balances and totals", async () => {
    const read = pdfStatementLines(await pdfLines(CHECKING_PDF), CHASE_CHECKING_PROFILE, "checking-1234/s.pdf");
    expect(summary(read)).toEqual([
      ["2025-12-30", 125_000, "Remote Online Deposit 1"],
      ["2026-01-02", 240_055, "Orig CO Name:Test Payments Orig ID:0000000000"],
      ["2026-01-05", -50_000, "CHECK 1001"],
      ["2026-01-06", -7_525, "CHECK 1002"],
      ["2026-01-08", -2_000, "Zelle Payment To Test Vendor Jpm00000001"],
      ["2026-01-15", -1_500, "Monthly Service Fee"],
    ]);
    expect(read[2]).toMatchObject({ checkNumber: "1001" });
  });

  it("reads every month's name in the period line", () => {
    const lines = (period: string) => [period, "Deposits and Additions", "12/10  DEPOSIT  5.00"].map((text, i) => ({ page: 1, line: i + 1, text }));
    const year = (period: string) => pdfStatementLines(lines(period), CHASE_CHECKING_PROFILE, "s.pdf")[0]!.occurredAt?.slice(0, 10);
    expect(year("November 16, 2025 through December 15, 2025")).toBe("2025-12-10");
    expect(year("Nov 6, 2025 through Dec. 5, 2025")).toBe("2024-12-10");
    expect(year("through Smarch 5, 2025")).toBeUndefined();
  });

  it("can't place undated years without Chase's period line, so the generic layout dead-letters those lines", async () => {
    const generic = pdfStatementLines(await pdfLines(CHECKING_PDF), GENERIC_BANK_PROFILE, "s.pdf");
    expect(generic.every((l) => l.occurredAt === undefined)).toBe(true);
  });

  it("reads the CSV download, trailing comma and check numbers included", () => {
    const read = csvStatementLines(CHECKING_CSV, CHASE_CHECKING_PROFILE, "a.csv");
    expect(summary(read)).toContainEqual(["2026-01-05", -50_000, "CHECK 1001"]);
    expect(read).toHaveLength(6);
    expect(read.find((l) => l.description === "CHECK 1002")).toMatchObject({ checkNumber: "1002", balanceCents: 1_309_530 });
  });

  it("stores the same transactions once whether they come from the CSV, the PDF or both", async () => {
    const keys = async (files: Record<string, string | Uint8Array>) =>
      (await eventsOf(chaseConnector({ accounts: accounts(files), now: NOW }))).map((e) => e.idempotencyKey).sort();
    const fromCsv = await keys({ "2026-01.csv": CHECKING_CSV });
    const fromPdf = await keys({ "2026-01.pdf": CHECKING_PDF });
    expect(fromCsv).toHaveLength(6);
    expect(fromPdf).toEqual(fromCsv);
    expect(new Set(await keys({ "2026-01.csv": CHECKING_CSV, "2026-01.pdf": CHECKING_PDF }))).toEqual(new Set(fromCsv));
  });
});

describe("Chase card statements", () => {
  it("reads a PDF with an opening/closing date range and a PURCHASE section", async () => {
    const read = pdfStatementLines(await pdfLines(CARD_PDF), CHASE_CARD_PROFILE, "card.pdf");
    expect(summary(read)).toEqual([
      ["2026-01-09", 100_000, "Payment Thank You - Web"],
      ["2025-12-28", -85_000, "TEST SUPPLIER INC"],
      ["2026-01-04", -4_210, "TEST SHIPPING CO"],
    ]);
  });

  it("reads the CSV download by transaction date, and matches the PDF", async () => {
    const csv = csvStatementLines(CARD_CSV, CHASE_CARD_PROFILE, "card.csv");
    const pdf = pdfStatementLines(await pdfLines(CARD_PDF), CHASE_CARD_PROFILE, "card.pdf");
    const sorted = (l: ReturnType<typeof summary>) => l.map(([d, a]) => `${d} ${a}`).sort();
    expect(sorted(summary(csv))).toEqual(sorted(summary(pdf)));
  });
});

describe("Chase connector", () => {
  it("syncs as the chase source, reading only the formats CHASE_IMPORT_MODE picks", async () => {
    const files = { "2026-01.csv": CHECKING_CSV, "2026-01.pdf": CHECKING_PDF };
    const pdfOnly = chaseConnector({ accounts: accounts(files, { "2026-01.csv": CARD_CSV }), formats: chaseFormats("manual_pdf"), now: NOW });
    expect(pdfOnly.source).toBe("chase");
    const events = await eventsOf(pdfOnly);
    expect(events).toHaveLength(6);
    expect(events.every((e) => String(e.payload.sourceRow).includes(".pdf:p"))).toBe(true);
    const csvOnly = await eventsOf(chaseConnector({ accounts: accounts(files, { "2026-01.csv": CARD_CSV }), formats: chaseFormats("manual_csv"), now: NOW }));
    expect(csvOnly).toHaveLength(9);
    expect(csvOnly.every((e) => /\.csv:\d+$/.test(String(e.payload.sourceRow)))).toBe(true);
  });

  it("maps every import mode, and refuses anything else without echoing it", () => {
    expect(CHASE_IMPORT_MODES.map(chaseFormats)).toEqual([["csv"], ["pdf"], ["csv", "pdf"]]);
    expect(chaseFormats(" manual_csv ")).toEqual(["csv"]);
    for (const bad of [undefined, "", "api", "MANUAL_CSV", "manual_csv,manual_pdf"]) {
      expect(() => chaseFormats(bad)).toThrow(/^CHASE_IMPORT_MODE must be one of manual_csv, manual_pdf, manual_csv_and_pdf$/);
    }
  });

  it("refuses an empty or unknown list of formats", () => {
    expect(() => bankStatementsConnector({ accounts: [], formats: [] })).toThrow("formats must list csv, pdf or both");
    expect(() => bankStatementsConnector({ accounts: [], formats: ["xlsx" as "csv"] })).toThrow("formats must list csv, pdf or both");
  });

  describe("account folders", () => {
    let dir = "";
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it("reads checking and savings folders with the checking profile and card folders with the card profile", async () => {
      dir = await mkdtemp(join(tmpdir(), "chase-"));
      for (const name of ["checking-1234", "savings-4321", "card-5678", "credit_card-8765", "notes", "checking-12"]) await mkdir(join(dir, name));
      await writeFile(join(dir, "card-5678", "2026-01.csv"), CARD_CSV);
      const found = await chaseAccountsFromDirectory(dir);
      expect(found.map((a) => [a.id, a.kind, a.profile?.id]).sort()).toEqual([
        ["card-5678", "credit_card", "chase_card"],
        ["checking-1234", "bank", "chase_checking"],
        ["credit_card-8765", "credit_card", "chase_card"],
        ["savings-4321", "bank", "chase_checking"],
      ]);
      expect(await eventsOf(chaseConnector({ accounts: found, now: NOW }))).toHaveLength(3);
    });
  });
});

describe("built-in bank profiles", () => {
  it("names generic and both Chase profiles, and nothing inherited", () => {
    expect(Object.keys(BANK_PROFILES)).toEqual(["generic", "chase_checking", "chase_card"]);
    expect(builtInBankProfile("chase_card")).toBe(CHASE_CARD_PROFILE);
    for (const name of ["toString", "__proto__", "constructor", "Chase_card"]) expect(builtInBankProfile(name)).toBeUndefined();
    expect(Object.isFrozen(BANK_PROFILES)).toBe(true);
  });

  it("are chosen by name in BANK_STATEMENTS_PROFILES, alone or per folder in a JSON file", async () => {
    const never = () => Promise.reject(new Error("should not read a file"));
    expect((await resolveBankProfiles(" chase_checking ", never))("anything-1234")).toBe(CHASE_CHECKING_PROFILE);
    const custom = { ...GENERIC_BANK_PROFILE, id: "test_bank", name: "Test bank" };
    const lookup = await resolveBankProfiles("/private/profiles.json", async () => JSON.stringify({ "checking-1234": "chase_checking", "card-5678": "chase_card", "*": custom }));
    expect(lookup("checking-1234")).toBe(CHASE_CHECKING_PROFILE);
    expect(lookup("card-5678")).toBe(CHASE_CARD_PROFILE);
    expect(lookup("savings-0001")).toEqual(parseBankProfile(custom));
  });

  it("refuses a folder that names an unknown built-in profile, without reading further", async () => {
    const read = async () => JSON.stringify({ "checking-1234": "wells_fargo" });
    await expect(resolveBankProfiles("p.json", read)).rejects.toThrow(new BankProfileError('BANK_STATEMENTS_PROFILES: "checking-1234" names no built-in profile'));
    await expect(resolveBankProfiles("p.json", async () => JSON.stringify({ x: "__proto__" }))).rejects.toThrow(BankProfileError);
  });

  it("accepts one transaction pattern or a list, checking each one's groups", () => {
    const pdf = (transaction: unknown) => parseBankProfile({ ...GENERIC_BANK_PROFILE, pdf: { ...CHASE_CHECKING_PROFILE.pdf, transaction } });
    expect(() => pdf(String.raw`^(?<date>\S+)\s+(?<description>.+)\s+(?<amount>\S+)$`)).not.toThrow();
    expect(() => pdf([])).toThrow(BankProfileError);
    expect(() => pdf([String.raw`^(?<date>\S+)\s+(?<description>.+)\s+(?<amount>\S+)$`, String.raw`^(?<date>\S+)\s+(?<amount>\S+)$`])).toThrow(/pdf\.transaction\.1/);
    expect(() => pdf(["(unclosed"])).toThrow(/pdf\.transaction\.0/);
  });
});
