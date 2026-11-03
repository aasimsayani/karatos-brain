import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  GENERIC_SUPPLIER_PROFILE,
  SUPPLIER_INVOICE_WRITES,
  SupplierFileError,
  SupplierProfileError,
  csvSupplierDocuments,
  diamondKind,
  documentStatements,
  documentType,
  dueFromTerms,
  memoryFileSource,
  parseSupplierInvoiceCursor,
  parseSupplierProfile,
  resolveSupplierProfiles,
  sha256,
  supplierEvents,
  supplierInvoicesConnector,
  suppliersFromDirectory,
  type SupplierEvent,
  type SupplierInvoiceOptions,
  type SupplierSource,
} from "../src/index.js";

const NOW = () => new Date("2026-02-10T00:00:00Z");
const RECEIVED = "2026-02-10T00:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

const SOW_CURRENT =
  "The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict, in compliance with United Nations Resolutions and corresponding national laws. The seller hereby guarantees that these diamonds are conflict free and confirms adherence to the WDC SoW Guidelines.";
const SOW_EARLIER =
  "The diamonds herein invoiced have been purchased from legitimate sources not involved in funding conflict and in compliance with United Nations resolutions. The seller hereby guarantees that these diamonds are conflict free, based on personal knowledge and/or written guarantees provided by the supplier of these diamonds.";

/** Two invoices and a third with its statement missing, under a title block, with the statement printed once under the first invoice's lines. */
const INVOICES = [
  "Test Supplier Co",
  "Invoice export",
  "",
  "Invoice #,Date,Style,Description,Stone,Qty,Unit Price,Amount",
  'INV-1001,01/15/2026,TEST-RING-1,14K engagement ring,Natural diamond 1.00ct,1,"2,400.00","2,400.00"',
  "INV-1001,01/15/2026,TEST-STUD-1,Lab-grown diamond studs,,2,300.00,",
  "INV-1001,01/15/2026,TEST-CHAIN-1,14K diamond-cut rope chain,,1,180.00,180.00",
  `INV-1001,,,"${SOW_CURRENT}",,,,`,
  "INV-1002,01/20/2026,TEST-BAND-1,Diamond band,,1,abc,",
  "INV-1002,13/45/2026,TEST-BAND-2,Plain band,,1,100.00,100.00",
  'INV-1003,01/25/2026,TEST-BRAC-1,Tennis bracelet,Diamond,1,"3,000.00","3,000.00"',
  ',,,,,,Total,"$6,280.00"',
].join("\r\n");

/** Memos with terms instead of due dates, two in one file, and a statement under them that belongs to neither. */
const MEMOS = [
  "Memo No,Memo Date,SKU,Description,Qty,Price,Terms",
  'M-501,01/10/2026,TEST-PEND-1,Sapphire pendant,1,"1,200.00",30 days memo',
  'M-501,01/10/2026,TEST-EAR-1,Diamond earrings,1,"2,000.00",Net 60',
  "M-502,02/01/2026,TEST-RING-9,Emerald ring,1,900.00,",
  `,,,"${SOW_CURRENT}",,,`,
].join("\n");

/** One invoice, its statement above the header in the earlier wording, with the Kimberley Process named. */
const ONE_INVOICE = [
  "Other Supplier",
  `"${SOW_EARLIER} Rough diamonds were imported under the Kimberley Process."`,
  "Invoice Number,Invoice Date,Item Number,Description,Quantity,Unit Cost,Extended",
  '77,02/02/2026,TEST-SOL-1,Round brilliant diamond,1,"5,000.00","5,000.00"',
].join("\n");

const OLD = "Invoice,Date,Amount\nINV-OLD,01/02/2019,10.00";

function suppliers(extra: Record<string, string> = {}): SupplierSource[] {
  return [
    { id: "test_supplier", source: memoryFileSource({ "2026-01-invoices.csv": INVOICES, "2026-01-memos.csv": MEMOS, "2019.csv": OLD, ...extra }) },
    { id: "other_supplier", source: memoryFileSource({ "inv-77.csv": ONE_INVOICE }) },
  ];
}

function connector(options: Partial<SupplierInvoiceOptions> = {}) {
  return supplierInvoicesConnector({ suppliers: suppliers(), now: NOW, batchSize: 3, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as SupplierEvent[]);
const CTX = { supplier: "test_supplier", fileName: "test_supplier/x.csv", receivedAt: RECEIVED, since: "2020-02-10T00:00:00.000Z" };
const lines = (text: string, file = "test_supplier/x.csv") => csvSupplierDocuments(text, GENERIC_SUPPLIER_PROFILE, file);

/** Reasons at noon on the day the tests run as, so the memo and warranty windows are fixed. */
function departmentsPipeline() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) }, now: () => new Date("2026-02-10T12:00:00Z") });
  return { memory, pipeline };
}

describe("reading supplier values", () => {
  it("tells natural diamonds from lab-grown ones, and from metal cut or shaped like one", () => {
    const cases: [string[], string][] = [
      [["Natural diamond 1.00ct"], "natural"],
      [["Diamond", "Tennis bracelet"], "natural"],
      [["", "DIA studs 0.50ctw"], "natural"],
      [["Round brilliant diamonds"], "natural"],
      [["Lab-grown diamond studs"], "lab_grown"],
      [["Laboratory created diamond"], "lab_grown"],
      [["LGD", "diamond solitaire"], "lab_grown"],
      [["CVD diamond"], "lab_grown"],
      [["HPHT diamond"], "lab_grown"],
      [["synthetic diamond"], "lab_grown"],
      [["man-made diamond"], "lab_grown"],
      [["cultured diamond"], "lab_grown"],
      [["14K diamond-cut rope chain"], "none"],
      [["diamond cut bangle"], "none"],
      [["diamond-shaped pendant"], "none"],
      [["simulated diamond"], "none"],
      [["imitation diamonds"], "none"],
      [["diamond simulant"], "none"],
      [["Sapphire pendant"], "none"],
      [["Moissanite ring"], "none"],
      [[], "none"],
      [["Diamond-cut band with diamond accents"], "natural"],
    ];
    for (const [texts, kind] of cases) expect(diamondKind(...texts), texts.join(" | ")).toBe(kind);
  });

  it("finds the System of Warranties statement in its current and earlier wording, and the Kimberley Process", () => {
    expect(documentStatements(SOW_CURRENT)).toEqual({ warrantyStatement: "current", kimberleyProcess: false });
    expect(documentStatements(SOW_EARLIER)).toEqual({ warrantyStatement: "earlier", kimberleyProcess: false });
    expect(documentStatements("Sold under the System of Warranties.")).toEqual({ warrantyStatement: "earlier", kimberleyProcess: false });
    expect(documentStatements("Per WDC SoW.")).toEqual({ warrantyStatement: "earlier", kimberleyProcess: false });
    expect(documentStatements("The seller guarantees that these diamonds are conflict-free.")).toEqual({ warrantyStatement: "earlier", kimberleyProcess: false });
    expect(documentStatements("NOT INVOLVED IN\nFUNDING   CONFLICT")).toEqual({ warrantyStatement: "earlier", kimberleyProcess: false });
    expect(documentStatements("Rough imported under the Kimberley Process (KPCS).")).toEqual({ warrantyStatement: "none", kimberleyProcess: true });
    expect(documentStatements("KPCS certificate attached")).toEqual({ warrantyStatement: "none", kimberleyProcess: true });
    expect(documentStatements("Conflict free guaranteed. Thank you for your business.")).toEqual({ warrantyStatement: "none", kimberleyProcess: false });
    expect(documentStatements("")).toEqual({ warrantyStatement: "none", kimberleyProcess: false });
  });

  it("reads the document type from its column, or from the file name without one", () => {
    for (const t of ["Memo", " memorandum ", "Consignment", "CONSIGNED", "on memo"]) expect(documentType(t, "x.csv"), t).toBe("memo");
    for (const t of ["Invoice", "INV", "sale", "Sales Invoice", "Bill", "purchase"]) expect(documentType(t, "x.csv"), t).toBe("invoice");
    for (const t of ["Credit memo", "Credit", "return", "memo invoice"]) expect(documentType(t, "memos.csv"), t).toBeNull();
    expect(documentType(undefined, "s/2026-memos.csv")).toBe("memo");
    expect(documentType("", "s/Consignment Jan.csv")).toBe("memo");
    expect(documentType(" ", "memo/invoices.csv")).toBe("invoice");
    expect(documentType(undefined, "s/invoices.csv")).toBe("invoice");
  });

  it("works a due date out from terms counted in days, and from nothing else", () => {
    const at = "2026-01-10T00:00:00.000Z";
    expect(dueFromTerms("30 days memo", at)).toBe("2026-02-09");
    expect(dueFromTerms("Net 60", at)).toBe("2026-03-11");
    expect(dueFromTerms("net30", at)).toBe("2026-02-09");
    expect(dueFromTerms("45 day", at)).toBe("2026-02-24");
    expect(dueFromTerms("14", at)).toBe("2026-01-24");
    for (const terms of ["COD", "2/10 net 30", "30 days EOM", "Net 1000", "", undefined]) expect(dueFromTerms(terms, at), String(terms)).toBeNull();
    expect(dueFromTerms("Net 30", undefined)).toBeNull();
  });
});

describe("supplier invoice profiles", () => {
  it("fills defaults and accepts a client's own profile", () => {
    const p = parseSupplierProfile({ id: "test_supplier", name: "Test", columns: { number: "Ref", date: "When", unitCost: "Each" } });
    expect(p).toMatchObject({ delimiter: ",", dateOrder: "mdy" });
    const doc = csvSupplierDocuments("Ref,When,Each\nA-1,01/02/2026,5.00", p, "f.csv");
    expect(doc.lines[0]).toMatchObject({ documentNumber: "A-1", amountCents: 500, documentType: "invoice" });
  });

  it("rejects a profile without the number, date or money, saying where", () => {
    expect(() => parseSupplierProfile({ id: "xx", name: "X", columns: { number: "N", date: "D" } })).toThrow(new SupplierProfileError("supplier invoice profile: columns need amount or unitCost"));
    expect(() => parseSupplierProfile({ id: "xx", name: "X", columns: { date: "D", amount: "A" } })).toThrow(/columns\.number/);
    expect(() => parseSupplierProfile({ id: "Bad Id", name: "X", columns: { number: "N", date: "D", amount: "A" } })).toThrow(/^supplier invoice profile is not valid: id:/);
    expect(() => parseSupplierProfile(null)).toThrow(/profile:/);
  });

  it("resolves SUPPLIER_INVOICES_PROFILES to the generic profile or a per-supplier JSON file, without echoing it", async () => {
    expect((await resolveSupplierProfiles(undefined))("a")).toBe(GENERIC_SUPPLIER_PROFILE);
    expect((await resolveSupplierProfiles(" generic "))("a")).toBe(GENERIC_SUPPLIER_PROFILE);
    const own = { id: "own", name: "Own", columns: { number: "N", date: "D", amount: "A" } };
    const lookup = await resolveSupplierProfiles("/p.json", async () => JSON.stringify({ test_supplier: "generic", "*": own }));
    expect(lookup("test_supplier")).toBe(GENERIC_SUPPLIER_PROFILE);
    expect(lookup("other").id).toBe("own");
    expect((await resolveSupplierProfiles("/p.json", async () => JSON.stringify({ a: own })))("b")).toBe(GENERIC_SUPPLIER_PROFILE);
    await expect(resolveSupplierProfiles("/secret/path.json", async () => "not json")).rejects.toThrow(new SupplierProfileError("SUPPLIER_INVOICES_PROFILES: could not read a JSON file (SyntaxError)"));
    await expect(resolveSupplierProfiles("/p.json", async () => { throw "x"; })).rejects.toThrow("SUPPLIER_INVOICES_PROFILES: could not read a JSON file (error)");
    await expect(resolveSupplierProfiles("/p.json", async () => "[]")).rejects.toThrow("SUPPLIER_INVOICES_PROFILES: the file must map supplier folders to profiles");
    await expect(resolveSupplierProfiles("/p.json", async () => "null")).rejects.toThrow("the file must map supplier folders to profiles");
    await expect(resolveSupplierProfiles("/p.json", async () => '{"a":"nope"}')).rejects.toThrow('SUPPLIER_INVOICES_PROFILES: "a" names no built-in profile');
    await expect(resolveSupplierProfiles("/p.json", async () => '{"a":"toString"}')).rejects.toThrow("names no built-in profile");
  });
});

describe("reading an invoice or memo export", () => {
  it("finds the header below the title block, keeps true line numbers, and skips the statement and total rows as lines", () => {
    const doc = lines(INVOICES);
    expect(doc.lines.map((l) => l.sourceRow.split(":")[1])).toEqual(["5", "6", "7", "9", "10", "11"]);
  });

  it("reads each line's item, quantity and cost in cents, working the amount out from the unit cost when it's blank", () => {
    const [ring, studs, chain] = lines(INVOICES).lines;
    expect(ring).toEqual({
      sourceRow: "test_supplier/x.csv:5",
      documentType: "invoice",
      documentNumber: "INV-1001",
      occurredAt: "2026-01-15T00:00:00.000Z",
      sku: "TEST-RING-1",
      description: "14K engagement ring",
      stone: "Natural diamond 1.00ct",
      quantity: 1,
      unitCostCents: 240_000,
      amountCents: 240_000,
      diamond: "natural",
    });
    expect(studs).toMatchObject({ quantity: 2, unitCostCents: 30_000, amountCents: 60_000, diamond: "lab_grown" });
    expect(chain).toMatchObject({ amountCents: 18_000, diamond: "none" });
  });

  it("reads each document's statement from its own rows when a file holds several", () => {
    const doc = lines(INVOICES);
    expect(Object.fromEntries(doc.statements)).toEqual({
      "INV-1001": { warrantyStatement: "current", kimberleyProcess: false },
      "INV-1002": { warrantyStatement: "none", kimberleyProcess: false },
      "INV-1003": { warrantyStatement: "none", kimberleyProcess: false },
    });
    // The statement under both memos has no number, so it can't be told which memo it belongs to.
    expect(lines(MEMOS).statements.get("M-501")).toEqual({ warrantyStatement: "none", kimberleyProcess: false });
  });

  it("reads a lone document's statement from above the header and from rows without a number", () => {
    expect(lines(ONE_INVOICE).statements.get("77")).toEqual({ warrantyStatement: "earlier", kimberleyProcess: true });
    const below = ["Invoice,Date,Amount", "9,02/02/2026,1.00", `,"${SOW_CURRENT}",`].join("\n");
    expect(lines(below).statements.get("9")).toEqual({ warrantyStatement: "current", kimberleyProcess: false });
  });

  it("dates a memo line from its terms, or its due column, and leaves an unreadable due date as null", () => {
    const memo = lines(MEMOS, "test_supplier/memos.csv").lines;
    expect(memo.map((l) => [l.documentType, l.amountCents, l.due])).toEqual([
      ["memo", 120_000, "2026-02-09"],
      ["memo", 200_000, "2026-03-11"],
      ["memo", 90_000, undefined],
    ]);
    const due = lines("Memo #,Date,Type,SKU,Amount,Due Back,Terms\nM-1,01/02/2026,Memo,TEST-1,1.00,02/01/2026,Net 90\nM-2,01/02/2026,Memo,TEST-2,1.00,soon,");
    expect(due.lines.map((l) => [l.documentType, l.due])).toEqual([
      ["memo", "2026-02-01"],
      ["memo", null],
    ]);
  });

  it("leaves what it can't read as null, so the line is dead-lettered and kept", () => {
    const [, , , band1, band2] = lines(INVOICES).lines;
    expect(band1).toMatchObject({ unitCostCents: null, amountCents: null, diamond: "natural" });
    expect(band2!.occurredAt).toBeUndefined();
    const odd = lines("Invoice,Date,Type,Qty,Unit Price,Amount\nA,01/02/2026,Credit,x,-5.00,\nB,01/02/2026,Invoice,0,5.00,").lines;
    expect(odd[0]).toMatchObject({ documentType: null, quantity: null, unitCostCents: null, amountCents: null });
    expect(odd[1]).toMatchObject({ quantity: null, amountCents: null });
    // An item with no money is still a line, so it is dead-lettered rather than lost.
    expect(lines("Invoice,Date,SKU,Amount\nA,01/02/2026,TEST-1,").lines).toMatchObject([{ sku: "TEST-1", amountCents: null }]);
    // Spacing is tidied in what is kept.
    expect(lines('Invoice,Date,SKU,Description,Amount\n" A-1 ",01/02/2026, TEST-1 ," 14K   gold  ring ",1.00').lines[0]).toMatchObject({ documentNumber: "A-1", sku: "TEST-1", description: "14K gold ring" });
  });

  it("names the missing columns when no row looks like the header", () => {
    expect(() => lines("Description,Price\nRing,1.00")).toThrow("test_supplier/x.csv has no column for Invoice or Invoice Number");
    expect(() => lines("Invoice,Date,Description\nA,01/02/2026,Ring")).toThrow("test_supplier/x.csv has no column for amount or unit cost");
    expect(() => lines("Invoice,Amount\nA,1.00")).toThrow("test_supplier/x.csv has no column for Date or Invoice Date");
  });
});

describe("supplier events", () => {
  it("produces buying-shaped lines with what their document says, and memo lines for the memo reminder", () => {
    const events = supplierEvents(lines(MEMOS, "test_supplier/memos.csv"), CTX);
    expect(events.map((e) => e.type)).toEqual(["supplier_invoice.line_imported", "memo.received", "supplier_invoice.line_imported", "memo.received", "supplier_invoice.line_imported"]);
    const [pendant, memo] = events as [SupplierEvent, SupplierEvent];
    expect(pendant).toMatchObject({ occurredAt: "2026-01-10T00:00:00.000Z", receivedAt: RECEIVED });
    expect(pendant.idempotencyKey).toMatch(/^supplier:test_supplier:memo:M-501:0:[0-9a-f]{12}$/);
    expect(pendant.id).toBe(pendant.idempotencyKey);
    expect(pendant.payload).toEqual({
      lineId: "supplier:test_supplier:memo:M-501:0",
      supplier: "test_supplier",
      documentType: "memo",
      documentNumber: "M-501",
      documentDate: "2026-01-10",
      sku: "TEST-PEND-1",
      description: "Sapphire pendant",
      quantity: 1,
      unitCostCents: 120_000,
      amountCents: 120_000,
      due: "2026-02-09",
      terms: "30 days memo",
      diamond: "none",
      warrantyStatement: "none",
      kimberleyProcess: false,
      currency: "USD",
      sourceRow: "test_supplier/memos.csv:2",
    });
    expect(memo.payload).toEqual({ memoId: "test_supplier/M-501/1", vendorId: "test_supplier", sku: "TEST-PEND-1", costCents: 120_000, dueBack: "2026-02-09" });
    expect(memo.idempotencyKey).toMatch(/^supplier:test_supplier:memo:M-501:0:memo:[0-9a-f]{12}$/);
    expect(events[3]!.payload.memoId).toBe("test_supplier/M-501/2");
  });

  it("sends a memo line to the memo reminder only with an item, a cost above zero and a due date", () => {
    const memo = (row: string) => supplierEvents(lines(`Memo #,Date,Type,SKU,Amount,Due Back\n${row}`), CTX).map((e) => e.type);
    expect(memo("M-1,01/02/2026,Memo,TEST-1,1.00,02/01/2026")).toEqual(["supplier_invoice.line_imported", "memo.received"]);
    expect(memo("M-1,01/02/2026,Memo,,1.00,02/01/2026")).toEqual(["supplier_invoice.line_imported"]);
    expect(memo("M-1,01/02/2026,Memo,TEST-1,0.00,02/01/2026")).toEqual(["supplier_invoice.line_imported"]);
    expect(memo("M-1,01/02/2026,Memo,TEST-1,-1.00,02/01/2026")).toEqual(["supplier_invoice.line_imported"]);
    expect(memo("M-1,01/02/2026,Memo,TEST-1,1.00,")).toEqual(["supplier_invoice.line_imported"]);
    expect(memo("M-1,01/02/2026,Memo,TEST-1,1.00,later")).toEqual(["supplier_invoice.line_imported"]);
    expect(memo("M-1,01/02/2026,Invoice,TEST-1,1.00,02/01/2026")).toEqual(["supplier_invoice.line_imported"]);
    expect(memo("M-1,xx,Memo,TEST-1,1.00,02/01/2026")).toEqual(["supplier_invoice.line_imported"]);
  });

  it("keys unreadable lines by where they are", () => {
    const events = supplierEvents(lines(INVOICES), CTX);
    const bad = events.filter((e) => e.payload.amountCents === null || e.occurredAt === undefined);
    expect(bad.map((e) => e.idempotencyKey)).toEqual(["supplier:test_supplier:row:test_supplier/x.csv:9", "supplier:test_supplier:row:test_supplier/x.csv:10"]);
    expect(bad[0]!.id).toBe("supplier:test_supplier:row:test_supplier_x.csv:9");
    expect(bad.map((e) => e.payload.documentDate)).toEqual(["2026-01-20", null]);
    const credit = supplierEvents(lines("Invoice,Date,Type,Amount\nC-1,01/02/2026,Credit,5.00"), CTX);
    expect(credit[0]!.idempotencyKey).toBe("supplier:test_supplier:row:test_supplier/x.csv:2");
  });

  it("numbers a document's lines, and keys the same line the same in any file", () => {
    const keys = (text: string, file: string) => supplierEvents(lines(text, file), { ...CTX, fileName: file }).map((e) => e.idempotencyKey);
    const a = keys(INVOICES, "test_supplier/a.csv");
    expect(a.slice(0, 3).map((k) => k.split(":").slice(0, 5).join(":"))).toEqual([
      "supplier:test_supplier:invoice:INV-1001:0",
      "supplier:test_supplier:invoice:INV-1001:1",
      "supplier:test_supplier:invoice:INV-1001:2",
    ]);
    expect(a.at(-1)!.split(":").slice(0, 5).join(":")).toBe("supplier:test_supplier:invoice:INV-1003:0");
    expect(keys(INVOICES, "test_supplier/b.csv").filter((k) => !k.includes(":row:"))).toEqual(a.filter((k) => !k.includes(":row:")));
    // The same number as a memo and as an invoice are two documents.
    const both = keys("Invoice,Date,Type,Amount\nX-1,01/02/2026,Memo,1.00\nX-1,01/02/2026,Invoice,1.00", "f.csv");
    expect(both.map((k) => k.split(":").slice(0, 5).join(":"))).toEqual(["supplier:test_supplier:memo:X-1:0", "supplier:test_supplier:invoice:X-1:0"]);
  });

  it("keys a corrected line, or a line whose document gained its statement, as a new version", () => {
    const key = (text: string) => supplierEvents(lines(text), CTX)[0]!.idempotencyKey;
    const first = key("Invoice,Date,Amount\nA-1,01/02/2026,5.00");
    expect(key("Invoice,Date,Amount\nA-1,01/02/2026,6.00")).not.toBe(first);
    expect(key(`Invoice,Date,Amount,Notes\nA-1,01/02/2026,5.00,"${SOW_CURRENT}"`)).not.toBe(first);
    expect(key("Invoice,Date,Amount\nA-1,01/02/2026,5.00")).toBe(first);
  });

  it("skips documents older than the history window", () => {
    expect(supplierEvents(lines(OLD), CTX)).toEqual([]);
    expect(supplierEvents(lines(OLD), { ...CTX, since: "2019-01-01T00:00:00.000Z" })).toHaveLength(1);
  });
});

describe("supplier invoices connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic({ INVOICES, MEMOS, ONE_INVOICE, OLD });
  });

  it("declares no writes, and the write gate turns every one down", async () => {
    expect(SUPPLIER_INVOICE_WRITES).toEqual([]);
    expect(connector().writes).toEqual([]);
    expect(await assertWritesRefused(connector())).toEqual([]);
  });

  it("survives every runSync scenario, with the buying schema dead-lettering unreadable lines", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), payloadSchemas: SCHEMAS, expected: { ingested: 10, deadLettered: 2 } });
    expect(result.replay.duplicates).toBe(10);
    expect(JSON.parse(result.full.cursor!)).toEqual({
      done: {
        "other_supplier/inv-77.csv": sha256(ONE_INVOICE),
        "test_supplier/2019.csv": sha256(OLD),
        "test_supplier/2026-01-invoices.csv": sha256(INVOICES),
        "test_supplier/2026-01-memos.csv": sha256(MEMOS),
      },
      current: null,
    });
  });

  it("feeds the buying department the lines it accepts, and dead-letters exactly the bad ones", async () => {
    const { memory, pipeline } = departmentsPipeline();
    expect(await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 10, deadLettered: 2 });
    expect(memory.deadLetters.map((d) => [(d.raw as SupplierEvent).payload.sourceRow, d.issues.map((i) => i.path).sort()])).toEqual([
      ["test_supplier/2026-01-invoices.csv:9", ["payload.amountCents", "payload.unitCostCents"]],
      ["test_supplier/2026-01-invoices.csv:10", ["occurredAt"]],
    ]);
  });

  it("reminds about the memo due back, and flags the recent documents for natural diamonds with no warranty statement", async () => {
    const { memory, pipeline } = departmentsPipeline();
    await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const summaries = (await pipeline.reason(TEST_ORG)).map((r) => r.summary);
    expect(summaries).toEqual(
      expect.arrayContaining([
        "Memo test_supplier/M-501/1 (TEST-PEND-1) from test_supplier was due back 1 days ago. It hasn't sold. Return it, or buy it for $1,200.00 if you want to keep it.",
        "Invoice INV-1003 from test_supplier (2026-01-25) lists a natural diamond but no System of Warranties statement was found on it. Ask test_supplier for a copy that carries the statement, and keep it with the purchase records.",
        "Memo M-501 from test_supplier (2026-01-10) lists a natural diamond but no System of Warranties statement was found on it. Ask test_supplier for a copy that carries the statement, and keep it with the purchase records.",
      ]),
    );
    expect(summaries.filter((s) => s.includes("System of Warranties"))).toHaveLength(2);
    const solitaire = memory.events.find((e) => e.payload.documentNumber === "77")!;
    expect(solitaire.payload).toMatchObject({ diamond: "natural", warrantyStatement: "earlier", kimberleyProcess: true });
    expect(summaries.filter((s) => s.startsWith("Memo test_supplier/"))).toHaveLength(1);
  });

  it("stores a line once when an overlapping export has it too, and a corrected one as its newer version", async () => {
    const source = memoryFileSource({ "2026-01-invoices.csv": INVOICES });
    const make = () => supplierInvoicesConnector({ suppliers: [{ id: "test_supplier", source }], now: NOW });
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 4, deadLettered: 2 });
    source.files["2026-01-corrected.csv"] = [
      "Invoice #,Date,Style,Description,Stone,Qty,Unit Price,Amount",
      'INV-1001,01/15/2026,TEST-RING-1,14K engagement ring,Natural diamond 1.00ct,1,"2,400.00","2,400.00"',
      "INV-1001,01/15/2026,TEST-STUD-1,Lab-grown diamond studs,,2,300.00,",
      "INV-1001,01/15/2026,TEST-CHAIN-1,14K diamond-cut rope chain,,1,180.00,180.00",
      `INV-1001,,,"${SOW_CURRENT}",,,,`,
      'INV-1003,01/25/2026,TEST-BRAC-1,Tennis bracelet,Diamond,1,"3,000.00","3,000.00"',
      `INV-1003,,,"${SOW_CURRENT}",,,,`,
    ].join("\n");
    expect(await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 1, duplicates: 3, deadLettered: 0 });
  });

  it("stops flagging an invoice once a corrected export carries its statement", async () => {
    const source = memoryFileSource({ "a.csv": "Invoice,Date,Description,Amount\nINV-9,02/01/2026,Diamond ring,10.00" });
    const make = () => supplierInvoicesConnector({ suppliers: [{ id: "test_supplier", source }], now: NOW });
    const { memory, pipeline } = departmentsPipeline();
    await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    const flagged = async () => (await pipeline.reason(TEST_ORG)).filter((r) => r.summary.includes("INV-9"));
    expect(await flagged()).toHaveLength(1);
    source.files["b.csv"] = `Invoice,Date,Description,Amount,Notes\nINV-9,02/01/2026,Diamond ring,10.00,"${SOW_CURRENT}"`;
    await runSync({ connector: make(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(await flagged()).toEqual([]);
  });

  it("reads nothing again when no file changed", async () => {
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const c = connector();
    await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(await runSync({ connector: c, mode: "historical", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ batches: 0, ingested: 0, duplicates: 0 });
    expect(await runSync({ connector: c, mode: "incremental", pipeline, memory, organizationId: TEST_ORG })).toMatchObject({ ingested: 0, duplicates: 10 });
  });

  it("keeps two suppliers' files apart, even with the same file name and document number", async () => {
    const same = "Invoice,Date,Amount\nINV-1,01/02/2026,1.00";
    const c = supplierInvoicesConnector({ suppliers: [{ id: "b_supplier", source: memoryFileSource({ "s.csv": same }) }, { id: "a_supplier", source: memoryFileSource({ "s.csv": same }) }], now: NOW });
    const events = await eventsOf(c);
    expect(events.map((e) => [e.payload.lineId, e.payload.sourceRow])).toEqual([
      ["supplier:a_supplier:invoice:INV-1:0", "a_supplier/s.csv:2"],
      ["supplier:b_supplier:invoice:INV-1:0", "b_supplier/s.csv:2"],
    ]);
  });

  it("reads only CSV files, in name order", async () => {
    const c = connector({ suppliers: [{ id: "test_supplier", source: memoryFileSource({ "b.CSV": OLD.replace("2019", "2026"), "a.csv": OLD.replace("2019", "2025"), "notes.txt": "x", "scan.pdf": "x" }) }] });
    expect((await eventsOf(c)).map((e) => e.payload.sourceRow)).toEqual(["test_supplier/a.csv:2", "test_supplier/b.CSV:2"]);
  });

  it("names the file when an export can't be read, and stops there", async () => {
    const broken = supplierInvoicesConnector({ suppliers: [{ id: "test_supplier", source: memoryFileSource({ "bad.csv": 'Invoice,Date,Amount\nA,"01/02/2026,1' }) }], now: NOW });
    await expect(eventsOf(broken)).rejects.toThrow(new SupplierFileError("test_supplier/bad.csv", "CSV line 2: a quoted field is never closed"));
    const noColumns = supplierInvoicesConnector({ suppliers: [{ id: "test_supplier", source: memoryFileSource({ "x.csv": "Date,Amount\n01/02/2026,1.00" }) }], now: NOW });
    await expect(eventsOf(noColumns)).rejects.toThrow(/^test_supplier\/x\.csv: has no column for Invoice or/);
    const other = supplierInvoicesConnector({ suppliers: [{ id: "test_supplier", source: { list: async () => [{ name: "a.csv" }], read: async () => { throw new TypeError("disk"); }, readBytes: async () => new Uint8Array() } as never }], now: NOW });
    await expect(eventsOf(other)).rejects.toThrow(new TypeError("disk"));
  });

  it("rejects bad options", () => {
    expect(() => connector({ batchSize: 0 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector({ batchSize: 1.5 })).toThrow("batchSize must be a positive whole number");
    expect(() => connector({ historyYears: 0 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector({ historyYears: 2.5 })).toThrow("historyYears must be a positive whole number");
    expect(() => connector({ suppliers: [{ id: "Test Supplier", source: memoryFileSource({}) }] })).toThrow('supplier "Test Supplier" must be a lowercase folder name');
    expect(() => connector({ suppliers: [...suppliers(), suppliers()[0]!] })).toThrow("supplier test_supplier is listed twice");
  });

  it("takes the history window from its options, six years by default", async () => {
    expect((await eventsOf(connector({ historyYears: 8 }))).some((e) => e.payload.documentNumber === "INV-OLD")).toBe(true);
    expect((await eventsOf(connector())).some((e) => e.payload.documentNumber === "INV-OLD")).toBe(false);
    const recent = "Invoice,Date,Amount\nINV-5Y,03/01/2020,1.00";
    expect((await eventsOf(connector({ suppliers: [{ id: "test_supplier", source: memoryFileSource({ "r.csv": recent }) }] }))).length).toBe(1);
  });

  it("checks the checkpoint it resumes from", () => {
    expect(parseSupplierInvoiceCursor(null)).toBeNull();
    expect(() => parseSupplierInvoiceCursor('{"done":null}')).toThrow("Supplier invoice import checkpoint is not in the expected shape");
  });

  it("finds one supplier per lowercase folder, and skips the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suppliers-"));
    for (const name of ["test_supplier", "Other Supplier", "x", "9supplier"]) await mkdir(join(dir, name));
    await writeFile(join(dir, "loose.csv"), ONE_INVOICE);
    await writeFile(join(dir, "test_supplier", "inv.csv"), ONE_INVOICE);
    const found = await suppliersFromDirectory(dir);
    expect(found.map((r) => [r.id, r.profile])).toEqual([["test_supplier", GENERIC_SUPPLIER_PROFILE]]);
    const own = parseSupplierProfile({ id: "own", name: "Own", columns: { number: "N", date: "D", amount: "A" } });
    expect((await suppliersFromDirectory(dir, () => own))[0]!.profile).toBe(own);
    const events = await eventsOf(supplierInvoicesConnector({ suppliers: found, now: NOW }));
    expect(events.map((e) => e.payload.documentNumber)).toEqual(["77"]);
  });
});
