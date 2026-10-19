import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrainPipeline, InMemoryStore, runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  CsvError,
  GENERIC_POS_PROFILE,
  PosFileError,
  PosProfileError,
  directorySource,
  fileKind,
  inventoryPosConnector,
  memoryFileSource,
  parseCsv,
  parseCsvRecords,
  parseDate,
  parseDecimal,
  parseFlag,
  parseInteger,
  parseMoney,
  parsePosCursor,
  parsePosProfile,
  posCategory,
  posMetal,
  posPaymentMethod,
  resolvePosProfile,
  sha256,
  type FileSource,
  type InventoryPosOptions,
  type PosCursor,
  type PosEvent,
  type PosProfileInput,
} from "../src/index.js";

const NOW = () => new Date("2026-01-10T00:00:00Z");
const RECEIVED = "2026-01-10T00:00:00.000Z";
const FILE_TIME = "2026-01-08T09:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

const ITEMS = [
  "SKU,Title,Category,Metal,Karat,Weight (g),Cost,Retail Price,Quantity,Vendor,On Memo,Received",
  'SKU-TEST-0001,"14k Cuban chain, 20""",Necklaces,14K Yellow Gold,,25.5,"$1,000.00","$2,400.00",1,Test Vendor 1,N,03/15/2025',
  'SKU-TEST-0002,Diamond studs,Earrings,Platinum,,,$800.00,"1,950",2,,Y,',
  "SKU-TEST-0003,Sold piece,Rings,,,,100,250,0,,,01/02/2024",
  "SKU-TEST-0004,Bad cost,Rings,,,,abc,250,1,,,01/02/2024",
  "SKU-TEST-0005,Old piece,Rings,,,,100,250,1,,,01/02/2019",
].join("\r\n");

const STOCK = ["SKU,On Hand,Date", "SKU-TEST-0001,1,01/05/2026", "SKU-TEST-0002,two,01/05/2026"].join("\n");

const CUSTOMERS = [
  "Customer ID,Name,Email,Phone,Marketing Opt In,Updated",
  "C-1,Test Customer 1,customer1@example.test,+1 212 555 0101,Yes,12/01/2025",
  "C-2,Test Customer 2,customer2@example.test,,maybe,12/02/2025",
].join("\n");

const SALES = [
  "Sale ID,Date,SKU,Quantity,Unit Price,Discount,Sale Total,Payment Method,Customer ID,Salesperson,Channel,Original Sale ID,Return ID",
  'R-100,01/03/2026 2:15 PM,SKU-TEST-0001,1,"$2,400.00",$100.00,"$2,671.38",Visa,C-1,Associate 1,,,',
  'R-100,01/03/2026 2:15 PM,SKU-TEST-0002,1,$150.00,,"$2,671.38",Visa,C-1,Associate 1,,,',
  "R-101,01/04/2026 11:00 AM,SKU-TEST-0002,-1,$150.00,$10.00,,Visa,C-1,,,R-100,RT-1",
  "R-102,01/05/2026,SKU-TEST-0006,1,$500.00,$25.00,,Cash,,,Online,,",
  "R-102,01/05/2026,SKU-TEST-0001,-1,$300.00,,,Cash,,,Online,,",
  "R-103,13/45/2026,SKU-TEST-0007,1,$10.00,,,Cash,,,,,",
].join("\n");

const FILES = () => ({
  "items-2026-01.csv": ITEMS,
  "stock-on-hand.csv": STOCK,
  "customers.csv": CUSTOMERS,
  "sales-2026-01.csv": SALES,
  "notes.txt": "not an export",
  "sales-summary.pdf": "%PDF-1.7",
});

function connector(source: FileSource = memoryFileSource(FILES(), FILE_TIME), options: Partial<InventoryPosOptions> = {}) {
  return inventoryPosConnector({ source, now: NOW, batchSize: 3, ...options });
}

async function collect(pages: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as PosEvent[]);
const byKey = (events: PosEvent[]) => new Map(events.map((e) => [e.idempotencyKey, e]));

function departmentsPipeline() {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({ memory, ...combineDepartments(RETAIL_DEPARTMENTS), documentation: { current: () => ({ documentIds: [], stale: false }) } });
  return { memory, pipeline };
}

describe("CSV reader", () => {
  it("reads quoted fields with commas, doubled quotes and line breaks, counting lines from the header", () => {
    const records = parseCsvRecords('a,b,c\n"x, y","say ""hi""","two\nlines"\nlast,,\n');
    expect(records).toEqual([
      { line: 1, fields: ["a", "b", "c"] },
      { line: 2, fields: ["x, y", 'say "hi"', "two\nlines"] },
      { line: 4, fields: ["last", "", ""] },
    ]);
  });

  it("handles a byte-order mark, CRLF, blank lines, a missing final newline and a quoted empty field", () => {
    expect(parseCsvRecords('﻿a,b\r\n\r\n1,2\r\n"",3')).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 3, fields: ["1", "2"] },
      { line: 4, fields: ["", "3"] },
    ]);
    expect(parseCsvRecords("")).toEqual([]);
    expect(parseCsvRecords('""')).toEqual([{ line: 1, fields: [""] }]);
  });

  it("uses another delimiter when told to", () => {
    expect(parseCsvRecords('a;b\n"1;2";3', ";")).toEqual([
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: ["1;2", "3"] },
    ]);
  });

  it("refuses malformed quoting, naming the line", () => {
    expect(() => parseCsvRecords('a\n"open')).toThrow(new CsvError(2, "a quoted field is never closed"));
    expect(() => parseCsvRecords('a\nb\n"x"y')).toThrow(/line 3: unexpected text after a closing quote/);
    expect(() => parseCsvRecords('a\nab"c')).toThrow(/line 2: a quote inside an unquoted field/);
  });

  it("maps rows onto trimmed headers, filling short rows and refusing long ones or repeated columns", () => {
    expect(parseCsv(" SKU ,Qty\nA,1\nB")).toEqual({
      headers: ["SKU", "Qty"],
      rows: [
        { line: 2, values: { SKU: "A", Qty: "1" } },
        { line: 3, values: { SKU: "B", Qty: "" } },
      ],
    });
    expect(() => parseCsv("a,b\n1,2,3")).toThrow(/line 2: 3 fields but only 2 columns/);
    expect(() => parseCsv("SKU,sku\n1,2")).toThrow(/"sku" appears twice/);
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});

describe("export values", () => {
  it("reads money in the styles exports use, without floating point", () => {
    const cases: [string | undefined, number | null][] = [
      ["$1,250.50", 125050],
      ["1250.5", 125050],
      ["0.07", 7],
      ["(25.00)", -2500],
      ["-$25", -2500],
      ["$-25", -2500],
      [" 3 ", 300],
      ["-0.00", 0],
      ["1,25", null],
      ["12,34,567", null],
      ["1.234", null],
      ["$", null],
      ["abc", null],
      ["", null],
      [undefined, null],
    ];
    for (const [text, cents] of cases) expect(parseMoney(text), String(text)).toBe(cents);
  });

  it("reads whole numbers, decimals and yes/no flags, returning null rather than guessing", () => {
    expect([parseInteger("3"), parseInteger("-1"), parseInteger("1,200"), parseInteger("1.5"), parseInteger(""), parseInteger("9".repeat(20))]).toEqual([3, -1, 1200, null, null, null]);
    expect([parseDecimal("3.25"), parseDecimal("4"), parseDecimal("-1"), parseDecimal("3g")]).toEqual([3.25, 4, null, null]);
    expect(["Y", "yes", "TRUE", "1", "x", "Opted In", "n", "No", "0", "", "maybe"].map(parseFlag)).toEqual([true, true, true, true, true, true, false, false, false, false, null]);
  });

  it("reads dates in the export's order at the store's offset, and rejects impossible ones", () => {
    expect(parseDate("03/10/2025", "mdy")).toBe("2025-03-10T00:00:00.000Z");
    expect(parseDate("03/10/2025", "dmy")).toBe("2025-10-03T00:00:00.000Z");
    expect(parseDate("3.10.25", "dmy")).toBe("2025-10-03T00:00:00.000Z");
    expect(parseDate("01/03/2026 2:15 PM", "mdy", "-05:00")).toBe("2026-01-03T19:15:00.000Z");
    expect(parseDate("01/03/2026 12:05 am", "mdy")).toBe("2026-01-03T00:05:00.000Z");
    expect(parseDate("01/03/2026 12:05 PM", "mdy")).toBe("2026-01-03T12:05:00.000Z");
    expect(parseDate("01/03/2026 23:59:30", "mdy", "+01:00")).toBe("2026-01-03T22:59:30.000Z");
    expect(parseDate("2026-01-03", "mdy", "-05:00")).toBe("2026-01-03T05:00:00.000Z");
    expect(parseDate("2026-01-03T10:00:00Z", "dmy", "-05:00")).toBe("2026-01-03T10:00:00.000Z");
    expect(parseDate("2026-01-03 10:00:00.123-0200", "ymd")).toBe("2026-01-03T12:00:00.000Z");
    for (const bad of ["02/30/2026", "13/01/2026", "01/03/2026 25:00", "01/03/2026 13:00 PM", "01/03/2026 0:30 AM", "2026-02-29", "yesterday", "", "01/03/2026 10:60"]) {
      expect(parseDate(bad, "mdy"), bad).toBeNull();
    }
    expect(parseDate("03/10/2025", "ymd")).toBeNull();
    expect(parseDate("2024-02-29", "ymd")).toBe("2024-02-29T00:00:00.000Z");
  });
});

describe("mapping profiles", () => {
  const custom: PosProfileInput = {
    id: "test_pos",
    name: "Test POS",
    files: { sales: "^tickets" },
    columns: { sales: { saleId: "Ticket", date: "When", sku: "Item", quantity: "Qty", unitPrice: "Each" } },
  };

  it("fills defaults and accepts a client's own profile", () => {
    expect(parsePosProfile(custom)).toMatchObject({ delimiter: ",", dateOrder: "mdy", utcOffset: "Z", payments: {}, categories: {} });
    expect(GENERIC_POS_PROFILE.id).toBe("generic");
  });

  it("refuses a profile that would read the wrong thing, saying where", () => {
    expect(() => parsePosProfile({ ...custom, id: "Has Spaces" })).toThrow(/id:/);
    expect(() => parsePosProfile({ ...custom, utcOffset: "EST" })).toThrow(/utcOffset/);
    expect(() => parsePosProfile({ ...custom, payments: { visa: "credit" } })).toThrow(/payments\.visa/);
    expect(() => parsePosProfile({ ...custom, files: { sales: "(" } })).toThrow(new PosProfileError("POS mapping profile: files.sales is not a valid pattern"));
    expect(() => parsePosProfile({ ...custom, files: { items: "item" } })).toThrow(/files.items is set but columns.items is missing/);
    expect(() => parsePosProfile(null)).toThrow(PosProfileError);
  });

  it("matches files to kinds by the profile's patterns, CSV and text files only", () => {
    expect(["items-2026-01.csv", "Stock On Hand.CSV", "client-list.txt", "Receipts.csv", "sales.pdf", "notes.txt", "sale.csv.bak"].map((n) => fileKind(n, GENERIC_POS_PROFILE))).toEqual([
      "items",
      "stock",
      "customers",
      "sales",
      null,
      null,
      null,
    ]);
    // The first kind in order wins when two patterns match.
    expect(fileKind("inventory-sales.csv", GENERIC_POS_PROFILE)).toBe("items");
  });

  it("resolves POS_MAPPING_PROFILE to the generic profile or a JSON file, without echoing the file", async () => {
    expect(await resolvePosProfile(undefined)).toBe(GENERIC_POS_PROFILE);
    expect(await resolvePosProfile(" generic ")).toBe(GENERIC_POS_PROFILE);
    const read = async (path: string) => (path === "/instance/pos.json" ? JSON.stringify(custom) : "{ not json SECRET-LOOKING");
    expect((await resolvePosProfile("/instance/pos.json", read)).id).toBe("test_pos");
    const error = await resolvePosProfile("/instance/bad.json", read).catch((e: Error) => e);
    expect(error).toBeInstanceOf(PosProfileError);
    expect((error as Error).message).toBe("POS_MAPPING_PROFILE: could not read a JSON profile (SyntaxError)");
    await expect(resolvePosProfile("/instance/missing.json", async () => Promise.reject(new Error("ENOENT")))).rejects.toThrow(/could not read a JSON profile \(Error\)/);
    const dir = await mkdtemp(join(tmpdir(), "pos-profile-"));
    await writeFile(join(dir, "pos.json"), JSON.stringify(custom));
    expect((await resolvePosProfile(join(dir, "pos.json"))).name).toBe("Test POS");
  });
});

describe("labels", () => {
  it("maps category labels, checking earrings before rings", () => {
    const labels = ["Engagement Rings", "Bridal", "Wedding Bands", "Earrings", "Hoops", "Necklaces", "Chains", "Pendants", "Bracelets", "Bangle", "Watches", "Loose Diamonds", "Rings", "Brooch", ""];
    expect(labels.map((l) => posCategory(l, GENERIC_POS_PROFILE))).toEqual([
      "engagement_ring",
      "engagement_ring",
      "wedding_band",
      "earrings",
      "earrings",
      "necklace",
      "necklace",
      "pendant",
      "bracelet",
      "bracelet",
      "watch",
      "loose_stone",
      "ring",
      "other",
      "other",
    ]);
    const profile = parsePosProfile({ ...GENERIC_POS_PROFILE, categories: { "fashion rings": "other" } });
    expect(posCategory("Fashion  Rings", profile)).toBe("other");
  });

  it("reads metal and karat, leaving unknown metals out", () => {
    expect(posMetal("14K Yellow Gold")).toEqual({ metal: "gold", karat: 14 });
    expect(posMetal("18kt white")).toEqual({ metal: "gold", karat: 18 });
    expect(posMetal("Sterling Silver")).toEqual({ metal: "silver" });
    expect(posMetal("925")).toEqual({ metal: "silver" });
    expect(posMetal("PT950")).toEqual({ metal: "platinum" });
    expect(posMetal("Palladium")).toEqual({ metal: "palladium" });
    expect(posMetal("Titanium")).toEqual({});
    expect(posMetal(undefined)).toEqual({});
  });

  it("maps payment labels, the profile's own first", () => {
    const labels = ["Visa", "AMEX", "Debit", "Cash", "Check", "Synchrony Financing", "Layaway", "Trade-In", "Gift Card", "Wire", "Zelle", "House account", ""];
    expect(labels.map((l) => posPaymentMethod(l, GENERIC_POS_PROFILE))).toEqual(["card", "card", "card", "cash", "check", "financing", "financing", "trade_in", "gift_card", "wire", "wire", "other", "other"]);
    const profile = parsePosProfile({ ...GENERIC_POS_PROFILE, payments: { "house account": "financing" } });
    expect(posPaymentMethod("House Account", profile)).toBe("financing");
  });
});

describe("Inventory and POS connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(FILES());
  });

  it("survives every runSync scenario, with the retail schemas dead-lettering the unreadable rows", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), payloadSchemas: SCHEMAS, expected: { ingested: 8, deadLettered: 4 } });
    // items 3, stock 2, customers 2, then sales 5 in batches of 3.
    expect(result.full.batches).toBe(5);
    expect(result.replay.duplicates).toBe(8);
    const cursor = JSON.parse(result.full.cursor!) as PosCursor;
    expect(cursor.current).toBeNull();
    expect(Object.keys(cursor.done).sort()).toEqual(["customers.csv", "items-2026-01.csv", "sales-2026-01.csv", "stock-on-hand.csv"]);
    expect(cursor.done["sales-2026-01.csv"]).toBe(sha256(SALES));
  });

  it("dead-letters exactly the rows it can't read, keeping where each came from", async () => {
    const { memory, pipeline } = departmentsPipeline();
    const report = await runSync({ connector: connector(), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 8, deadLettered: 4 });
    const dead = memory.deadLetters.map((d) => ({ row: (d.raw as PosEvent).payload.sourceRow, paths: d.issues.map((i) => i.path) }));
    expect(dead).toEqual([
      { row: "items-2026-01.csv:5", paths: ["payload.costCents"] },
      { row: "stock-on-hand.csv:3", paths: ["payload.onHand"] },
      { row: "customers.csv:3", paths: ["payload.marketingConsent"] },
      { row: "sales-2026-01.csv:7", paths: ["occurredAt"] },
    ]);
  });

  it("records each piece received, skipping sold-out and older rows", async () => {
    const events = byKey(await eventsOf());
    expect(events.get("pos:generic:item:SKU-TEST-0001")).toEqual({
      id: "pos_generic:item:SKU-TEST-0001",
      type: "inventory.received",
      occurredAt: "2025-03-15T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "pos:generic:item:SKU-TEST-0001",
      payload: {
        sku: "SKU-TEST-0001",
        title: '14k Cuban chain, 20"',
        category: "necklace",
        posCategory: "Necklaces",
        metal: "gold",
        karat: 14,
        weightGrams: 25.5,
        costCents: 100_000,
        retailPriceCents: 240_000,
        quantity: 1,
        vendorId: "pos:generic:vendor:Test Vendor 1",
        onMemo: false,
        sourceRow: "items-2026-01.csv:2",
      },
    });
    // No received date: the file's own time.
    expect(events.get("pos:generic:item:SKU-TEST-0002")).toMatchObject({
      occurredAt: FILE_TIME,
      payload: { category: "earrings", metal: "platinum", costCents: 80_000, retailPriceCents: 195_000, quantity: 2, onMemo: true },
    });
    expect(events.get("pos:generic:item:SKU-TEST-0002")!.payload).not.toHaveProperty("karat");
    expect(events.has("pos:generic:item:SKU-TEST-0003")).toBe(false);
    expect(events.has("pos:generic:item:SKU-TEST-0005")).toBe(false);
  });

  it("records stock counts and customer profiles without contact details", async () => {
    const events = await eventsOf();
    const counts = events.filter((e) => e.type === "inventory.counted");
    expect(counts.map((e) => [e.idempotencyKey, e.occurredAt, e.payload.onHand])).toEqual([
      ["pos:generic:count:SKU-TEST-0001:2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z", 1],
      ["pos:generic:count:SKU-TEST-0002:2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z", null],
    ]);
    const customer = events.find((e) => e.type === "customer.profile_updated")!;
    expect(customer).toMatchObject({
      occurredAt: "2025-12-01T00:00:00.000Z",
      idempotencyKey: `pos:generic:customer:C-1:${sha256("Test Customer 1|true").slice(0, 12)}`,
      payload: { customerId: "pos:generic:customer:C-1", name: "Test Customer 1", marketingConsent: true, sourceRow: "customers.csv:2" },
    });
    expect(JSON.stringify(events)).not.toMatch(/example\.test|555/);
  });

  it("groups sale lines into receipts, and negative lines into returns", async () => {
    const events = byKey(await eventsOf());
    expect(events.get("pos:generic:sale:R-100")).toMatchObject({
      type: "sale.completed",
      occurredAt: "2026-01-03T14:15:00.000Z",
      payload: {
        saleId: "pos:generic:sale:R-100",
        customerId: "pos:generic:customer:C-1",
        channel: "store",
        lines: [
          { sku: "SKU-TEST-0001", quantity: 1, unitPriceCents: 240_000, discountCents: 10_000 },
          { sku: "SKU-TEST-0002", quantity: 1, unitPriceCents: 15_000, discountCents: 0 },
        ],
        // The export's own total includes tax, so it wins over the lines' sum of $2,450.
        totalCents: 267_138,
        payments: [{ method: "card", amountCents: 267_138 }],
        salespersonId: "pos:generic:staff:Associate 1",
        sourceRow: "sales-2026-01.csv:2",
      },
    });
    expect(events.get("pos:generic:return:RT-1")).toEqual({
      id: "pos_generic:return:RT-1",
      type: "sale.returned",
      occurredAt: "2026-01-04T11:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: "pos:generic:return:RT-1",
      payload: { saleId: "pos:generic:sale:R-100", returnId: "pos:generic:return:RT-1", lines: [{ sku: "SKU-TEST-0002", quantity: 1, refundCents: 14_000 }], sourceRow: "sales-2026-01.csv:4" },
    });
    expect(events.has("pos:generic:sale:R-101")).toBe(false);
    // An exchange: one receipt gives a sale and a return. With no Sale Total column filled, the total is the lines less discounts.
    expect(events.get("pos:generic:sale:R-102")!.payload).toMatchObject({ channel: "online", totalCents: 47_500, payments: [{ method: "cash", amountCents: 47_500 }], lines: [{ sku: "SKU-TEST-0006", discountCents: 2_500 }] });
    expect(events.get("pos:generic:sale:R-102")!.payload).not.toHaveProperty("customerId");
    expect(events.get("pos:generic:return:R-102")!.payload).toMatchObject({ saleId: "pos:generic:sale:R-102", lines: [{ sku: "SKU-TEST-0001", quantity: 1, refundCents: 30_000 }] });
    expect(events.get("pos:generic:sale:R-103")!.occurredAt).toBeUndefined();
  });

  it("leaves unreadable sale values null for the sales schema to reject, and never drops a line", async () => {
    const sales = [
      "Sale ID,Date,SKU,Quantity,Unit Price,Discount,Payment Method",
      "S-1,01/03/2026,SKU-TEST-0001,one,$10.00,,Visa",
      "S-1,01/03/2026,SKU-TEST-0002,1,$10.00,,Cash",
      "S-2,01/03/2026,SKU-TEST-0001,1,ten,,Visa",
      "S-3,01/03/2026,SKU-TEST-0001,1,$10.00,lots,Visa",
      "S-4,01/03/2026,SKU-TEST-0001,0,$10.00,,Visa",
      "S-5,01/03/2026,SKU-TEST-0001,-2,$10.00,bad,",
    ].join("\n");
    const events = byKey(await eventsOf(connector(memoryFileSource({ "sales.csv": sales }))));
    expect(events.get("pos:generic:sale:S-1")!.payload).toMatchObject({
      lines: [{ quantity: null }, { quantity: 1 }],
      totalCents: null,
      // Lines that name different tenders give one "other" payment.
      payments: [{ method: "other", amountCents: null }],
    });
    expect(events.get("pos:generic:sale:S-2")!.payload).toMatchObject({ lines: [{ unitPriceCents: null }], totalCents: null });
    expect(events.get("pos:generic:sale:S-3")!.payload).toMatchObject({ lines: [{ discountCents: null }], totalCents: null });
    // A zero-quantity line (a voided line) makes no sale.
    expect(events.has("pos:generic:sale:S-4")).toBe(false);
    expect(events.get("pos:generic:return:S-5")!.payload).toMatchObject({ lines: [{ quantity: 2, refundCents: null }] });

    const { memory, pipeline } = departmentsPipeline();
    const report = await runSync({ connector: connector(memoryFileSource({ "sales.csv": sales })), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 4 });
  });

  it("reads nothing again when no file changed, and only what is new or changed when one did", async () => {
    const source = memoryFileSource(FILES(), FILE_TIME);
    const { memory, pipeline } = testPipeline([], SCHEMAS);
    const sync = (mode: "historical" | "incremental") => runSync({ connector: connector(source), mode, pipeline, memory, organizationId: TEST_ORG });
    expect(await sync("historical")).toMatchObject({ ingested: 8, deadLettered: 4, batches: 5 });
    expect(await sync("historical")).toMatchObject({ ingested: 0, duplicates: 0, deadLettered: 0, batches: 0 });

    // A new day's export and a corrected customer list.
    source.files["sales-2026-01-09.csv"] = [SALES.split("\n")[0], "R-200,01/09/2026,SKU-TEST-0008,1,$75.00,,,Cash,,,,,"].join("\n");
    source.files["customers.csv"] = CUSTOMERS.replace("maybe", "No");
    expect(await sync("historical")).toMatchObject({ ingested: 2, duplicates: 1, deadLettered: 0, batches: 2 });
    expect(memory.events.some((e) => e.idempotencyKey === "pos:generic:sale:R-200")).toBe(true);

    // Incremental syncs keep their own checkpoint, so the first reads every file; all of it is already stored.
    expect(await sync("incremental")).toMatchObject({ ingested: 0, duplicates: 10 });
    expect(await sync("incremental")).toMatchObject({ batches: 0 });
  });

  it("stores a changed customer as a new profile event, and the same customer exported again as a duplicate", async () => {
    const one = (name: string, consent: string) => memoryFileSource({ "customers.csv": `Customer ID,Name,Marketing Opt In\nC-9,${name},${consent}` });
    const key = async (name: string, consent: string) => (await eventsOf(connector(one(name, consent))))[0]!.idempotencyKey;
    expect(await key("Test Customer 9", "Y")).toBe(await key("Test Customer 9", "yes"));
    expect(await key("Test Customer 9", "Y")).not.toBe(await key("Test Customer 9", "N"));
    expect(await key("Test Customer 9", "Y")).not.toBe(await key("Test Customer 99", "Y"));
    // Consent is never assumed from an empty column.
    const [blank] = await eventsOf(connector(memoryFileSource({ "customers.csv": "Customer ID,Name,Marketing Opt In\nC-9,Test Customer 9," })));
    expect(blank!.payload.marketingConsent).toBe(false);
  });

  it("resumes an interrupted file where it stopped, and from the top if the file changed meanwhile", async () => {
    const source = memoryFileSource({ "sales-2026-01.csv": SALES });
    const cursor = (next: number, hash = sha256(SALES)): string => JSON.stringify({ done: {}, current: { name: "sales-2026-01.csv", hash, next } } satisfies PosCursor);
    const resumed = await collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: cursor(3) }));
    expect(resumed.flatMap((b) => (b.events as PosEvent[]).map((e) => e.idempotencyKey))).toEqual(["pos:generic:return:R-102", "pos:generic:sale:R-103"]);
    const restarted = await collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: cursor(3, sha256("older version")) }));
    expect(restarted.flatMap((b) => b.events)).toHaveLength(5);
    // A checkpoint past the end (the file shrank to the same hash cannot happen, but a bad count must not loop).
    const past = await collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: cursor(99) }));
    expect(past).toEqual([{ events: [], cursor: JSON.stringify({ done: { "sales-2026-01.csv": sha256(SALES) }, current: null }) }]);
  });

  it("writes each batch's checkpoint so a crash loses at most one batch", async () => {
    const pages = await collect(connector(memoryFileSource({ "sales-2026-01.csv": SALES })).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(pages.map((p) => [p.events.length, JSON.parse(p.cursor)])).toEqual([
      [3, { done: {}, current: { name: "sales-2026-01.csv", hash: sha256(SALES), next: 3 } }],
      [2, { done: { "sales-2026-01.csv": sha256(SALES) }, current: null }],
    ]);
  });

  it("records an empty export as read, and forgets files that left the folder", async () => {
    const empty = "SKU,Title,Cost,Retail Price\n";
    const stock = "SKU,On Hand\nSKU-TEST-0001,1";
    const source = memoryFileSource({ "items.csv": empty, "stock.csv": stock });
    const saved: PosCursor = { done: { "gone.csv": sha256("x") }, current: null };
    const pages = await collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: JSON.stringify(saved) }));
    expect(pages.map((p) => [p.events.length, JSON.parse(p.cursor)])).toEqual([
      [0, { done: { "items.csv": sha256(empty) }, current: null }],
      [1, { done: { "items.csv": sha256(empty), "stock.csv": sha256(stock) }, current: null }],
    ]);
  });

  it("reads files in kind order, then by name, so receipts come before the sales that use them", async () => {
    const read: string[] = [];
    const base = memoryFileSource({ "sales-b.csv": "Sale ID,Date,SKU,Quantity,Unit Price\n", "sales-a.csv": "Sale ID,Date,SKU,Quantity,Unit Price\n", "items.csv": "SKU,Title,Cost,Retail Price\n", "customers.csv": "Customer ID,Name\n", "stock.csv": "SKU,On Hand\n" });
    const source = { list: base.list, read: async (name: string) => (read.push(name), base.read(name)) };
    await collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(read).toEqual(["items.csv", "stock.csv", "customers.csv", "sales-a.csv", "sales-b.csv"]);
  });

  it("stops with the file and the missing columns named when an export doesn't match the profile", async () => {
    const source = memoryFileSource({ "sales.csv": "Receipt,Qty\nR-1,1" });
    const error = await collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: null })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(PosFileError);
    expect((error as Error).message).toBe("sales.csv: sales.csv has no column for Date or Sale Date, SKU or Item Number or Stock Number, Unit Price or Price");
    const malformed = memoryFileSource({ "items.csv": 'SKU,Title,Cost,Retail Price\n"SKU-TEST-0001,x,1,2' });
    await expect(collect(connector(malformed).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow("items.csv: CSV line 2: a quoted field is never closed");
  });

  it("passes other failures through unchanged, for runSync to retry", async () => {
    const source = { list: async () => [{ name: "sales.csv", modifiedAt: FILE_TIME }], read: async () => Promise.reject(new Error("disk unplugged")) };
    await expect(collect(connector(source).historicalImport({ organizationId: TEST_ORG, cursor: null }))).rejects.toThrow(/^disk unplugged$/);
  });

  it("reads a client's own profile: its columns, delimiter, date order, offset and labels", async () => {
    const profile = parsePosProfile({
      id: "test_pos",
      name: "Test POS",
      delimiter: ";",
      dateOrder: "dmy",
      utcOffset: "-05:00",
      files: { sales: "^tickets", items: "^stock-list" },
      columns: {
        sales: { saleId: "Ticket", date: "When", sku: "Item", quantity: "Qty", unitPrice: "Each", paymentMethod: "Tender", channel: "Where" },
        items: { sku: "Item", title: "Desc", category: "Dept", karat: "Kt", cost: "Cost", retailPrice: "Tag" },
      },
      payments: { "house acct": "financing" },
      categories: { "fine jewelry": "pendant" },
    });
    const source = memoryFileSource({
      "tickets-0109.csv": "Ticket;When;Item;Qty;Each;Tender;Where\nT-1;09/01/2026 16:30;SKU-TEST-0001;2;12,50;House Acct;Trunk Show",
      "stock-list.csv": "Item;Desc;Dept;Kt;Cost;Tag\nSKU-TEST-0001;Test piece;Fine Jewelry;18K;5;12,50",
      "sales.csv": "ignored by this profile",
    });
    const events = byKey(await eventsOf(connector(source, { profile })));
    expect([...events.keys()].sort()).toEqual(["pos:test_pos:item:SKU-TEST-0001", "pos:test_pos:sale:T-1"]);
    expect(events.get("pos:test_pos:sale:T-1")).toMatchObject({
      occurredAt: "2026-01-09T21:30:00.000Z",
      payload: { saleId: "pos:test_pos:sale:T-1", channel: "event", lines: [{ quantity: 2, unitPriceCents: null }], payments: [{ method: "financing" }] },
    });
    expect(events.get("pos:test_pos:item:SKU-TEST-0001")!.payload).toMatchObject({ category: "pendant", karat: 18, costCents: 500, retailPriceCents: null });
  });

  it("keeps an unrecognized metal under posMetal and a bad karat or weight as null", async () => {
    const items = "SKU,Title,Metal,Karat,Weight (g),Cost,Retail Price\nSKU-TEST-0001,Test piece,Titanium,fourteen,3g,1,2";
    const [e] = await eventsOf(connector(memoryFileSource({ "items.csv": items })));
    expect(e!.payload).toMatchObject({ posMetal: "Titanium", karat: null, weightGrams: null, category: "other" });
    expect(e!.payload).not.toHaveProperty("metal");
    expect(e!.payload).not.toHaveProperty("posCategory");
  });

  it("dead-letters a negative item quantity and a bad received date", async () => {
    const items = "SKU,Title,Cost,Retail Price,Quantity,Received\nSKU-TEST-0001,Test piece,1,2,-1,\nSKU-TEST-0002,Test piece,1,2,1,someday";
    const { memory, pipeline } = departmentsPipeline();
    const report = await runSync({ connector: connector(memoryFileSource({ "items.csv": items })), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 0, deadLettered: 2 });
    expect(memory.deadLetters.map((d) => d.issues.map((i) => i.path))).toEqual([["payload.quantity"], ["occurredAt"]]);
  });

  it("honours historyYears, keeping rows on the cutoff and dropping older ones", async () => {
    const sales = "Sale ID,Date,SKU,Quantity,Unit Price\nS-1,2024-01-10,SKU-TEST-0001,1,1\nS-2,2024-01-09 23:59,SKU-TEST-0001,1,1";
    const events = await eventsOf(connector(memoryFileSource({ "sales.csv": sales }), { historyYears: 2 }));
    expect(events.map((e) => e.idempotencyKey)).toEqual(["pos:generic:sale:S-1"]);
  });

  it("runs the same way incrementally, writes nothing back, and takes no webhooks", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("inventory_pos");
    expect(c.writes).toEqual([]);
    expect(c.handleWebhook).toBeUndefined();
    expect(() => inventoryPosConnector({ source: memoryFileSource({}), batchSize: 0 })).toThrow(/batchSize/);
    expect(() => inventoryPosConnector({ source: memoryFileSource({}), batchSize: 1.5 })).toThrow(/batchSize/);
  });

  it("refuses a checkpoint it didn't write", () => {
    const hash = sha256("x");
    expect(parsePosCursor(null)).toBeNull();
    expect(parsePosCursor(JSON.stringify({ done: { "a.csv": hash }, current: { name: "b.csv", hash, next: 0 } }))).toMatchObject({ current: { next: 0 } });
    for (const bad of [
      "null",
      "{}",
      JSON.stringify({ done: null, current: null }),
      JSON.stringify({ done: { "a.csv": "short" }, current: null }),
      JSON.stringify({ done: {}, current: { name: "b.csv", hash: "nope", next: 0 } }),
      JSON.stringify({ done: {}, current: { name: "b.csv", hash, next: -1 } }),
      JSON.stringify({ done: {}, current: { name: "b.csv", hash, next: 1.5 } }),
      JSON.stringify({ done: {}, current: { name: 7, hash, next: 1 } }),
      JSON.stringify({ done: {} }),
    ]) {
      expect(() => parsePosCursor(bad), bad).toThrow(/not in the expected shape/);
    }
  });

  it("reads a real folder, skipping hidden files and subfolders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pos-import-"));
    await writeFile(join(dir, "items.csv"), "SKU,Title,Cost,Retail Price\nSKU-TEST-0001,Test piece,1,2");
    await writeFile(join(dir, ".items-lock.csv"), "SKU,Title,Cost,Retail Price\nSKU-TEST-0009,Hidden,1,2");
    await mkdir(join(dir, "sales-archive.csv"));
    const source = directorySource(dir);
    const files = await source.list();
    expect(files.map((f) => f.name)).toEqual(["items.csv"]);
    expect(Number.isNaN(Date.parse(files[0]!.modifiedAt))).toBe(false);
    const events = await eventsOf(connector(source));
    expect(events.map((e) => e.idempotencyKey)).toEqual(["pos:generic:item:SKU-TEST-0001"]);
    expect(events[0]!.occurredAt).toBe(files[0]!.modifiedAt);
    await expect(memoryFileSource({}).read("missing.csv")).rejects.toThrow(/no file named missing.csv/);
  });
});
