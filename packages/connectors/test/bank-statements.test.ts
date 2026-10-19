import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  BankProfileError,
  GENERIC_BANK_PROFILE,
  StatementFileError,
  accountKind,
  accountsFromDirectory,
  bankCategory,
  bankStatementsConnector,
  csvStatementLines,
  memoryFileSource,
  parseBankProfile,
  parseBankStatementCursor,
  resolveBankProfiles,
  sha256,
  statementEvents,
  type BankEvent,
  type BankStatementOptions,
  type StatementAccountSource,
} from "../src/index.js";

const NOW = () => new Date("2026-01-10T00:00:00Z");
const RECEIVED = "2026-01-10T00:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

const CHECKING = [
  "Test Bank Business Checking",
  "Account ending 1234",
  "Statement period 01/01/2026 - 01/31/2026",
  "",
  "Date,Description,Debit,Credit,Balance,Check Number",
  '01/02/2026,Beginning Balance,,,"10,000.00",',
  '01/02/2026,BRANCH DEPOSIT,,"1,250.00","11,250.00",',
  '01/03/2026,STRIPE TRANSFER ST-TEST0001,,"2,400.55","13,650.55",',
  '01/05/2026,CHECK 1001,"500.00",,"13,150.55",1001',
  '01/05/2026,GUSTO   PAYROLL TEST,"3,000.00",,"10,150.55",',
  '01/06/2026,MONTHLY SERVICE FEE,"15.00",,"10,135.55",',
  '01/06/2026,ONLINE TRANSFER TO SAVINGS 2345,"1,000.00",,"9,135.55",',
  '01/07/2026,MOBILE DEPOSIT,,"200.00","9,335.55",',
  '01/08/2026,ZELLE PAYMENT TO TEST VENDOR,"20.00",,"9,315.55",',
  '01/08/2026,ZELLE PAYMENT TO TEST VENDOR,"20.00",,"9,295.55",',
  "01/09/2026,BAD AMOUNT ROW,twenty,,,",
  '13/45/2026,BAD DATE ROW,"5.00",,,',
  ',Total,"4,560.00","3,850.55",,',
].join("\r\n");

const OLD = "Date,Description,Amount\n01/02/2019,OLD ROW,5.00";

const CARD = [
  "Transaction Date,Post Date,Description,Category,Type,Amount",
  "01/04/2026,01/05/2026,TEST SUPPLIER INC,Shopping,Sale,-850.00",
  '01/09/2026,01/09/2026,PAYMENT THANK YOU,,Payment,"1,000.00"',
  "01/09/2026,01/09/2026,LATE FEE,Fees,Fee,-39.00",
].join("\n");

function accounts(extra: Record<string, string> = {}): StatementAccountSource[] {
  return [
    { id: "checking-1234", kind: "bank", source: memoryFileSource({ "activity-2026-01.csv": CHECKING, "activity-2019.csv": OLD, "statement-2026-01.pdf": "%PDF-1.7", ...extra }) },
    { id: "card-5678", kind: "credit_card", source: memoryFileSource({ "card-2026-01.csv": CARD }) },
  ];
}

function connector(options: Partial<BankStatementOptions> = {}) {
  return bankStatementsConnector({ accounts: accounts(), now: NOW, batchSize: 4, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as BankEvent[]);

function departmentsPipeline() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
  return { memory, pipeline };
}

const ctx = (kind: "bank" | "credit_card" = "bank") => ({ account: { id: "checking-1234", kind }, profile: GENERIC_BANK_PROFILE, fileName: "f.csv", receivedAt: RECEIVED, since: "2020-01-10T00:00:00.000Z" });

describe("bank statement profiles", () => {
  const custom = { id: "test_bank", name: "Test Bank", columns: { date: "Posted", description: "Payee", amount: "Amt" } };

  it("fills defaults and accepts a client's own profile", () => {
    expect(parseBankProfile(custom)).toMatchObject({ delimiter: ",", dateOrder: "mdy", utcOffset: "Z", amounts: "money_in_positive", categories: [] });
  });

  it("refuses a profile that can't find an amount, or has a bad rule, saying where", () => {
    expect(() => parseBankProfile({ ...custom, columns: { date: "Posted", description: "Payee", debit: "Out" } })).toThrow(/columns: map either amount, or both debit and credit/);
    expect(() => parseBankProfile({ ...custom, amounts: "positive" })).toThrow(/amounts/);
    expect(() => parseBankProfile({ ...custom, categories: [{ match: "(", category: "fee" }] })).toThrow(new BankProfileError("bank statement profile: categories.0.match is not a valid pattern"));
    expect(() => parseBankProfile({ ...custom, categories: [{ match: "x", category: "rent" }] })).toThrow(/categories\.0\.category/);
    expect(() => parseBankProfile({ ...custom, id: "Test" })).toThrow(/id:/);
  });

  it("resolves BANK_STATEMENTS_PROFILES to the generic profile or a per-account JSON file, without echoing it", async () => {
    expect((await resolveBankProfiles(undefined))("checking-1234")).toBe(GENERIC_BANK_PROFILE);
    expect((await resolveBankProfiles("generic"))("x")).toBe(GENERIC_BANK_PROFILE);
    const file = JSON.stringify({ "card-5678": { ...custom, amounts: "money_out_positive" }, "*": { ...custom, id: "test_rest" } });
    const lookup = await resolveBankProfiles("/instance/banks.json", async () => file);
    expect(lookup("card-5678")).toMatchObject({ id: "test_bank", amounts: "money_out_positive" });
    expect(lookup("checking-1234").id).toBe("test_rest");
    expect((await resolveBankProfiles("/i.json", async () => JSON.stringify({ "card-5678": custom })))("checking-1234")).toBe(GENERIC_BANK_PROFILE);
    await expect(resolveBankProfiles("/i.json", async () => "{ SECRET-LOOKING")).rejects.toThrow(/^BANK_STATEMENTS_PROFILES: could not read a JSON file \(SyntaxError\)$/);
    await expect(resolveBankProfiles("/i.json", async () => "[]")).rejects.toThrow(/must map account folders/);
    await expect(resolveBankProfiles("/i.json", async () => "null")).rejects.toThrow(/must map account folders/);
    await expect(resolveBankProfiles("/i.json", async () => JSON.stringify({ x: { id: "BAD" } }))).rejects.toThrow(BankProfileError);
    const dir = await mkdtemp(join(tmpdir(), "bank-profile-"));
    await writeFile(join(dir, "banks.json"), file);
    expect((await resolveBankProfiles(join(dir, "banks.json")))("card-5678").id).toBe("test_bank");
  });
});

describe("categories", () => {
  const cases: [string, number, "bank" | "credit_card", string][] = [
    ["BRANCH DEPOSIT", 125_000, "bank", "cash_deposit"],
    ["DEPOSIT ID 0001", 50_000, "bank", "cash_deposit"],
    ["ATM CASH DEPOSIT", 20_000, "bank", "cash_deposit"],
    ["MOBILE DEPOSIT", 20_000, "bank", "other"],
    ["REMOTE DEPOSIT CAPTURE", 20_000, "bank", "other"],
    ["DEPOSIT MOBILE 0001", 20_000, "bank", "other"],
    ["deposit id 0002", 50_000, "bank", "cash_deposit"],
    ["Monthly   service fee", -1_500, "bank", "fee"],
    ["BILL   PAY TEST VENDOR", -50_000, "bank", "vendor_payment"],
    ["CASH WITHDRAWAL", -20_000, "bank", "other"],
    ["STRIPE TRANSFER ST-1", 240_055, "bank", "card_settlement"],
    ["SHOPIFY REFUND", 4_000, "credit_card", "other"],
    ["ONLINE TRANSFER FROM SAVINGS 2345", 100_000, "bank", "other"],
    ["STRIPE PAYOUT", 240_055, "bank", "card_settlement"],
    ["SQUARE INC DEPOSIT", 9_900, "bank", "card_settlement"],
    ["BANKCARD MERCHANT SETTLEMENT", 9_900, "bank", "card_settlement"],
    ["ORIG CO NAME:GUSTO PAYROLL", -300_000, "bank", "payroll"],
    ["GUSTO REFUND", 1_000, "bank", "other"],
    ["MONTHLY SERVICE FEE", -1_500, "bank", "fee"],
    ["OVERDRAFT ITEM", -3_500, "bank", "fee"],
    ["CHECK 1001", -50_000, "bank", "vendor_payment"],
    ["ACH DEBIT TEST VENDOR", -50_000, "bank", "vendor_payment"],
    ["BILLPAY TEST VENDOR", -50_000, "bank", "vendor_payment"],
    ["DEBIT CARD PURCHASE TEST SHOP", -5_000, "bank", "vendor_payment"],
    ["AUTOPAY CARD PAYMENT", -100_000, "bank", "other"],
    ["TEST SUPPLIER INC", -85_000, "credit_card", "vendor_payment"],
    ["TEST SUPPLIER INC", -85_000, "bank", "other"],
    ["PAYMENT THANK YOU", 100_000, "credit_card", "other"],
    ["BRANCH DEPOSIT", 100_000, "credit_card", "other"],
    ["LATE FEE", -3_900, "credit_card", "fee"],
    ["INTEREST PAYMENT", 12, "bank", "other"],
    ["ANYTHING", 0, "bank", "other"],
  ];

  it("sorts transactions by description, direction and account type", () => {
    for (const [description, amount, kind, category] of cases) {
      expect(bankCategory(description, amount, kind, GENERIC_BANK_PROFILE), `${description} ${amount} ${kind}`).toBe(category);
    }
    expect(bankCategory("anything", null, "bank", GENERIC_BANK_PROFILE)).toBe("other");
  });

  it("applies the client's own rules first, in order", () => {
    const profile = parseBankProfile({
      ...GENERIC_BANK_PROFILE,
      categories: [
        { match: "branch deposit", category: "other" },
        { match: "test landlord|deposit", category: "vendor_payment" },
      ],
    });
    expect(bankCategory("BRANCH DEPOSIT", 100_000, "bank", profile)).toBe("other");
    expect(bankCategory("Zelle to Test Landlord", -200_000, "bank", profile)).toBe("vendor_payment");
    expect(bankCategory("MONTHLY SERVICE FEE", -1_500, "bank", profile)).toBe("fee");
  });
});

describe("CSV statement lines", () => {
  it("finds the header below a title block and keeps true line numbers", () => {
    const lines = csvStatementLines(CHECKING, GENERIC_BANK_PROFILE, "checking-1234/a.csv");
    expect(lines.map((l) => l.sourceRow)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => `checking-1234/a.csv:${n}`));
    expect(lines[0]).toEqual({ sourceRow: "checking-1234/a.csv:7", occurredAt: "2026-01-02T00:00:00.000Z", amountCents: 125_000, description: "BRANCH DEPOSIT", balanceCents: 1_125_000 });
    expect(lines[2]).toMatchObject({ amountCents: -50_000, checkNumber: "1001" });
    expect(lines[3]!.description).toBe("GUSTO PAYROLL TEST");
    expect(lines.at(-2)).toMatchObject({ amountCents: null, description: "BAD AMOUNT ROW" });
    expect(lines.at(-1)).toMatchObject({ occurredAt: undefined, amountCents: -500 });
  });

  it("reads one signed column, either way round, and nets a row with both debit and credit", () => {
    expect(csvStatementLines(CARD, GENERIC_BANK_PROFILE, "c.csv").map((l) => l.amountCents)).toEqual([-85_000, 100_000, -3_900]);
    const flipped = parseBankProfile({ id: "test_card", name: "Test", amounts: "money_out_positive", columns: { date: "Date", description: "Description", amount: "Amount" } });
    expect(csvStatementLines("Date,Description,Amount\n01/04/2026,TEST SUPPLIER,850.00\n01/09/2026,PAYMENT,-1000\n01/09/2026,ZERO,0", flipped, "c.csv").map((l) => l.amountCents)).toEqual([-85_000, 100_000, 0]);
    expect(csvStatementLines("Date,Description,Debit,Credit\n01/04/2026,BOTH,(10.00),25.00", GENERIC_BANK_PROFILE, "b.csv")[0]!.amountCents).toBe(1_500);
    expect(csvStatementLines("Date,Description,Debit,Credit\n01/04/2026,BAD CREDIT,,abc", GENERIC_BANK_PROFILE, "b.csv")[0]!.amountCents).toBeNull();
  });

  it("matches headers without regard to case or spacing, and skips signed rows with no amount", () => {
    const lines = csvStatementLines("date,  DESCRIPTION ,amount\n01/02/2026,Beginning Balance,\n01/03/2026,TEST,-1.00", GENERIC_BANK_PROFILE, "l.csv");
    expect(lines).toEqual([{ sourceRow: "l.csv:3", occurredAt: "2026-01-03T00:00:00.000Z", amountCents: -100, description: "TEST" }]);
  });

  it("reads dates in the bank's order at its offset, with any delimiter", () => {
    const profile = parseBankProfile({ id: "test_eu", name: "Test", delimiter: ";", dateOrder: "dmy", utcOffset: "+01:00", columns: { date: "Datum", description: "Text", amount: "Betrag" } });
    expect(csvStatementLines('Datum;Text;Betrag\n09/01/2026;"TEST; SHOP";-12,50', profile, "e.csv")).toEqual([
      { sourceRow: "e.csv:2", occurredAt: "2026-01-08T23:00:00.000Z", amountCents: null, description: "TEST; SHOP" },
    ]);
  });

  it("names the file and the missing columns when no header row matches", () => {
    expect(() => csvStatementLines("When,What,How Much\n01/02/2026,X,1", GENERIC_BANK_PROFILE, "x.csv")).toThrow(/^x\.csv has no column for Date or Posting Date or Transaction Date or Posted Date, Description or Memo or Details or Payee, Amount$/);
    const split = parseBankProfile({ id: "test_split", name: "Test", columns: { date: "Date", description: "Memo", debit: "Out", credit: "In" } });
    expect(() => csvStatementLines("Date,Memo,Out\n01/02/2026,X,1", split, "y.csv")).toThrow(/^y\.csv has no column for In$/);
    expect(() => csvStatementLines("", GENERIC_BANK_PROFILE, "empty.csv")).toThrow(/empty\.csv has no column for Date/);
  });
});

describe("statement events", () => {
  it("numbers identical same-day transactions so both are kept, and keys exclude the description", () => {
    const lines = [
      { sourceRow: "a.csv:2", occurredAt: "2026-01-08T00:00:00.000Z", amountCents: -2_000, description: "ZELLE PAYMENT TO TEST VENDOR" },
      { sourceRow: "a.csv:3", occurredAt: "2026-01-08T00:00:00.000Z", amountCents: -2_000, description: "ZELLE PAYMENT TO TEST VENDOR" },
      { sourceRow: "a.csv:4", occurredAt: "2026-01-08T00:00:00.000Z", amountCents: -2_001, description: "OTHER" },
      { sourceRow: "a.csv:5", occurredAt: "2026-01-09T00:00:00.000Z", amountCents: -2_000, description: "ZELLE" },
    ];
    const keys = statementEvents(lines, ctx()).map((e) => e.idempotencyKey);
    expect(keys).toEqual(["bank:checking-1234:2026-01-08:-2000:0", "bank:checking-1234:2026-01-08:-2000:1", "bank:checking-1234:2026-01-08:-2001:0", "bank:checking-1234:2026-01-09:-2000:0"]);
    // The same transaction cut short, as a PDF statement might print it, gets the same key.
    const truncated = statementEvents([{ ...lines[0]!, description: "ZELLE PAYMENT TO TE", sourceRow: "s.pdf:1" }], ctx());
    expect(truncated[0]!.idempotencyKey).toBe(keys[0]);
  });

  it("keys an unreadable line by where it is, and skips lines older than the history window", () => {
    const events = statementEvents(
      [
        { sourceRow: "a.csv:9", occurredAt: undefined, amountCents: -500, description: "BAD DATE" },
        { sourceRow: "a.csv:10", occurredAt: "2026-01-02T00:00:00.000Z", amountCents: null, description: "BAD AMOUNT" },
        { sourceRow: "a.csv:11", occurredAt: "2020-01-10T00:00:00.000Z", amountCents: 1, description: "ON CUTOFF" },
        { sourceRow: "a.csv:12", occurredAt: "2020-01-09T23:59:59.000Z", amountCents: 1, description: "TOO OLD" },
      ],
      ctx(),
    );
    expect(events.map((e) => e.idempotencyKey)).toEqual(["bank:checking-1234:row:a.csv:9", "bank:checking-1234:row:a.csv:10", "bank:checking-1234:2020-01-10:1:0"]);
    expect(events[0]!.occurredAt).toBeUndefined();
    expect(events[1]!.payload).toMatchObject({ amountCents: null, category: "other" });
  });
});

describe("bank statements connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ CHECKING, OLD, CARD });
  });

  it("survives every runSync scenario, with the finance schema dead-lettering unreadable rows", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), payloadSchemas: SCHEMAS, expected: { ingested: 12, deadLettered: 2 } });
    // card 3 in one batch; the 2019 file empty in one; checking 11 in three.
    expect(result.full.batches).toBe(5);
    expect(result.replay.duplicates).toBe(12);
    expect(JSON.parse(result.full.cursor!)).toEqual({
      done: { "card-5678/card-2026-01.csv": sha256(CARD), "checking-1234/activity-2019.csv": sha256(OLD), "checking-1234/activity-2026-01.csv": sha256(CHECKING) },
      current: null,
    });
  });

  it("feeds the finance department transactions it accepts, and dead-letters exactly the bad rows", async () => {
    const { memory, pipeline } = departmentsPipeline();
    const report = await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 12, deadLettered: 2 });
    expect(memory.deadLetters.map((d) => [(d.raw as BankEvent).payload.sourceRow, d.issues.map((i) => i.path)])).toEqual([
      ["checking-1234/activity-2026-01.csv:16", ["payload.amountCents"]],
      ["checking-1234/activity-2026-01.csv:17", ["occurredAt"]],
    ]);
  });

  it("produces finance-shaped transactions with their category", async () => {
    const events = await eventsOf();
    expect(events.find((e) => e.payload.description === "BRANCH DEPOSIT")).toEqual({
      id: "bank_checking-1234:2026-01-02:125000:0",
      type: "bank.transaction_imported",
      occurredAt: "2026-01-02T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "bank:checking-1234:2026-01-02:125000:0",
      payload: {
        transactionId: "bank:checking-1234:2026-01-02:125000:0",
        accountId: "bank:checking-1234",
        accountKind: "bank",
        amountCents: 125_000,
        description: "BRANCH DEPOSIT",
        category: "cash_deposit",
        balanceCents: 1_125_000,
        sourceRow: "checking-1234/activity-2026-01.csv:7",
      },
    });
    const summary = events.filter((e) => e.payload.amountCents !== null && e.occurredAt).map((e) => [e.payload.accountId, e.payload.amountCents, e.payload.category]);
    expect(summary).toEqual([
      ["bank:card-5678", -85_000, "vendor_payment"],
      ["bank:card-5678", 100_000, "other"],
      ["bank:card-5678", -3_900, "fee"],
      ["bank:checking-1234", 125_000, "cash_deposit"],
      ["bank:checking-1234", 240_055, "card_settlement"],
      ["bank:checking-1234", -50_000, "vendor_payment"],
      ["bank:checking-1234", -300_000, "payroll"],
      ["bank:checking-1234", -1_500, "fee"],
      ["bank:checking-1234", -100_000, "other"],
      ["bank:checking-1234", 20_000, "other"],
      ["bank:checking-1234", -2_000, "vendor_payment"],
      ["bank:checking-1234", -2_000, "vendor_payment"],
    ]);
    expect(events.some((e) => e.payload.description === "OLD ROW" || e.payload.description === "Beginning Balance" || e.payload.description === "Total")).toBe(false);
  });

  it("stores a transaction once when an overlapping export in another layout has it too", async () => {
    const overlap = ["Posting Date,Description,Amount", "01/08/2026,ZELLE PAYMENT TO TEST VENDOR,-20.00", "01/08/2026,Zelle payment to Test Vendor,-20.00", '01/02/2026,DEPOSIT,"1,250.00"', "01/10/2026,NEW AFTER OVERLAP,-5.00"].join("\n");
    const source = memoryFileSource({ "activity-2026-01.csv": CHECKING });
    const make = () => bankStatementsConnector({ accounts: [{ id: "checking-1234", kind: "bank", source }], now: NOW });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 9, deadLettered: 2 });
    source.files["activity-2026-01-08.csv"] = overlap;
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, duplicates: 3, deadLettered: 0 });
  });

  it("reads nothing again when no file changed", async () => {
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const c = connector();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ batches: 0, ingested: 0, duplicates: 0 });
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 12 });
  });

  it("keeps two accounts' files apart, even with the same file name", async () => {
    const same = "Date,Description,Amount\n01/08/2026,TEST,-20.00";
    const c = bankStatementsConnector({
      accounts: [
        { id: "checking-1234", kind: "bank", source: memoryFileSource({ "jan.csv": same }) },
        { id: "savings-2345", kind: "bank", source: memoryFileSource({ "jan.csv": same }) },
      ],
      now: NOW,
    });
    const pages = await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(pages.flatMap((p) => (p.events as BankEvent[]).map((e) => e.idempotencyKey))).toEqual(["bank:checking-1234:2026-01-08:-2000:0", "bank:savings-2345:2026-01-08:-2000:0"]);
    expect(Object.keys(JSON.parse(pages.at(-1)!.cursor).done)).toEqual(["checking-1234/jan.csv", "savings-2345/jan.csv"]);
  });

  it("resumes an interrupted file where it stopped", async () => {
    const cursor = JSON.stringify({ done: { "card-5678/card-2026-01.csv": sha256(CARD), "checking-1234/activity-2019.csv": sha256(OLD) }, current: { name: "checking-1234/activity-2026-01.csv", hash: sha256(CHECKING), next: 8 } });
    const pages = await collect(connector().historicalImport({ organizationId: TEST_ORG, cursor }));
    expect(pages.flatMap((p) => (p.events as BankEvent[]).map((e) => e.payload.sourceRow))).toEqual(["checking-1234/activity-2026-01.csv:15", "checking-1234/activity-2026-01.csv:16", "checking-1234/activity-2026-01.csv:17"]);
  });

  it("stops with the account, file and missing columns named when an export doesn't match", async () => {
    const c = bankStatementsConnector({ accounts: [{ id: "checking-1234", kind: "bank", source: memoryFileSource({ "x.csv": "When,What\n1,2" }) }], now: NOW });
    const error = await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(StatementFileError);
    expect((error as Error).message).toMatch(/^checking-1234\/x\.csv: checking-1234\/x\.csv has no column for Date/);
    const malformed = bankStatementsConnector({ accounts: [{ id: "checking-1234", kind: "bank", source: memoryFileSource({ "x.csv": 'Date,Description,Amount\n"01/02/2026,X,1' }) }], now: NOW });
    await expect(collect(malformed.historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("checking-1234/x.csv: CSV line 2: a quoted field is never closed");
    const broken: StatementAccountSource = { id: "checking-1234", kind: "bank", source: { list: async () => [{ name: "x.csv", modifiedAt: RECEIVED }], read: async () => Promise.reject(new Error("disk unplugged")) } };
    await expect(collect(bankStatementsConnector({ accounts: [broken] }).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/^disk unplugged$/);
  });

  it("reads six years back by default", async () => {
    const source = memoryFileSource({ "old.csv": "Date,Description,Amount\n07/01/2020,FIVE AND A HALF YEARS,1.00\n01/09/2020,SIX YEARS AND A DAY,1.00" });
    const events = await eventsOf(bankStatementsConnector({ accounts: [{ id: "checking-1234", kind: "bank", source }], now: NOW }));
    expect(events.map((e) => e.payload.description)).toEqual(["FIVE AND A HALF YEARS"]);
  });

  it("uses each account's own profile", async () => {
    const flipped = parseBankProfile({ id: "test_card", name: "Test", amounts: "money_out_positive", columns: { date: "Date", description: "Description", amount: "Amount" } });
    const c = bankStatementsConnector({ accounts: [{ id: "card-5678", kind: "credit_card", source: memoryFileSource({ "a.csv": "Date,Description,Amount\n01/04/2026,TEST SUPPLIER,850.00" }), profile: flipped }], now: NOW });
    expect((await eventsOf(c))[0]!.payload).toMatchObject({ amountCents: -85_000, category: "vendor_payment", accountKind: "credit_card" });
  });

  it("refuses account names that would mix up accounts", () => {
    const source = memoryFileSource({});
    expect(() => bankStatementsConnector({ accounts: [{ id: "Checking 1234", kind: "bank", source }] })).toThrow(/must be named like checking-1234/);
    expect(() => bankStatementsConnector({ accounts: [{ id: "checking", kind: "bank", source }] })).toThrow(/must be named like/);
    expect(() =>
      bankStatementsConnector({
        accounts: [
          { id: "checking-1234", kind: "bank", source },
          { id: "checking-1234", kind: "bank", source },
        ],
      }),
    ).toThrow(/listed twice/);
    expect(() => bankStatementsConnector({ accounts: [], batchSize: 0 })).toThrow(/batchSize/);
    expect(accountKind("card-5678")).toBe("credit_card");
    expect(accountKind("amex_credit-1001")).toBe("credit_card");
    expect(accountKind("checking-1234")).toBe("bank");
  });

  it("finds accounts in a real folder, one per subfolder named like checking-1234", async () => {
    const dir = await mkdtemp(join(tmpdir(), "statements-"));
    for (const name of ["checking-1234", "card-5678", "Old Statements", "savings"]) await mkdir(join(dir, name));
    await writeFile(join(dir, "loose.csv"), "x");
    await writeFile(join(dir, "checking-1234", "jan.csv"), "Date,Description,Amount\n01/08/2026,TEST,-20.00");
    const flipped = parseBankProfile({ id: "test_card", name: "Test", amounts: "money_out_positive", columns: { date: "Date", description: "Description", amount: "Amount" } });
    const found = await accountsFromDirectory(dir, (id) => (id === "card-5678" ? flipped : GENERIC_BANK_PROFILE));
    expect(found.map((a) => [a.id, a.kind, a.profile?.id]).sort()).toEqual([
      ["card-5678", "credit_card", "test_card"],
      ["checking-1234", "bank", "generic"],
    ]);
    expect((await accountsFromDirectory(dir)).every((a) => a.profile === GENERIC_BANK_PROFILE)).toBe(true);
    const events = await eventsOf(bankStatementsConnector({ accounts: found, now: NOW }));
    expect(events.map((e) => e.idempotencyKey)).toEqual(["bank:checking-1234:2026-01-08:-2000:0"]);
  });

  it("runs the same way incrementally, writes nothing back, takes no webhooks, and checks its checkpoint", async () => {
    const c = connector();
    expect((await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events)).toEqual(await eventsOf());
    expect(c.source).toBe("bank_statements");
    expect(c.writes).toEqual([]);
    expect(c.handleWebhook).toBeUndefined();
    expect(parseBankStatementCursor(null)).toBeNull();
    expect(() => parseBankStatementCursor(JSON.stringify({ done: { a: "short" }, current: null }))).toThrow(/^Bank statement import checkpoint is not in the expected shape$/);
  });
});
