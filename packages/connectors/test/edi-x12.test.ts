import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSync, type SourceBatch } from "@karatos/core";
import { RETAIL_DEPARTMENTS, combineDepartments } from "@karatos/retail";
import { TEST_ORG, assertSynthetic, assertWritesRefused, checkConnectorSync, testPipeline } from "@karatos/connector-testkit";
import {
  EDI_EVENT_TYPES,
  EDI_X12_WRITES,
  EdiFileError,
  X12Error,
  directorySource,
  ediX12Connector,
  memoryFileSource,
  parseEdiCursor,
  parseX12,
  partnerOf,
  productIds,
  sha256,
  skuOf,
  x12Cents,
  x12Date,
  x12ImpliedCents,
  x12Quantity,
  type EdiCursor,
  type EdiEvent,
  type EdiX12Options,
  type FileSource,
} from "../src/index.js";

const NOW = () => new Date("2026-01-10T00:00:00Z");
const RECEIVED = "2026-01-10T00:00:00.000Z";
const SCHEMAS = combineDepartments(RETAIL_DEPARTMENTS).payloadSchemas;

const RETAILER = "RETAILERTEST";
const BRAND = "BRANDTEST";

interface Envelope {
  from?: string;
  to?: string;
  control?: string;
  usage?: "P" | "T";
  element?: string;
  segment?: string;
  /** Text after each segment terminator, such as a line break. */
  after?: string;
  functionalId?: string;
}

/** A fixed-width ISA segment, as the standard lays it out. */
function isa(e: Required<Pick<Envelope, "from" | "to" | "control" | "usage" | "element">>): string {
  const pad = (v: string, n: number) => v.padEnd(n, " ");
  return ["ISA", "00", pad("", 10), "00", pad("", 10), "ZZ", pad(e.from, 15), "ZZ", pad(e.to, 15), "260110", "1200", "U", "00401", e.control.padStart(9, "0"), "0", e.usage, ">"].join(e.element);
}

/** One interchange holding one group of transaction sets, each given as its segments between ST and SE. */
function interchange(sets: { set: string; segments: string[]; seCount?: number; seControl?: string }[], e: Envelope = {}): string {
  const element = e.element ?? "*";
  const segment = e.segment ?? "~";
  const after = e.after ?? "\n";
  const control = e.control ?? "1";
  const from = e.from ?? RETAILER;
  const to = e.to ?? BRAND;
  const join = (s: string) => s.split("*").join(element);
  const lines = [isa({ from, to, control, usage: e.usage ?? "P", element }), join(`GS*${e.functionalId ?? "PO"}*${from}*${to}*20260110*1200*${control}*X*004010`)];
  sets.forEach((t, i) => {
    const st = String(i + 1).padStart(4, "0");
    lines.push(join(`ST*${t.set}*${st}`), ...t.segments.map(join), join(`SE*${t.seCount ?? t.segments.length + 2}*${t.seControl ?? st}`));
  });
  lines.push(join(`GE*${sets.length}*${control}`), join(`IEA*1*${control.padStart(9, "0")}`));
  return lines.map((l) => `${l}${segment}${after}`).join("");
}

const PO_850 = ["BEG*00*SA*PO-TEST-1001**20260105", "DTM*002*20260120", "N1*ST*Test Store 1*92*STORE-01", "N3*1 Test Street", "PO1*1*2*EA*450.00**VN*STYLE-TEST-01*UP*000000000017", "PO1*2*1*EA*1250.50**VN*STYLE-TEST-02", "CTT*2"];
const ACK_855 = ["BAK*00*AC*PO-TEST-1001*20260105*****20260106", "PO1*1*2*EA*450.00**VN*STYLE-TEST-01", "ACK*IA*2*EA", "PO1*2*1*EA*1250.50**VN*STYLE-TEST-02", "ACK*IB*1*EA**20260125", "CTT*2"];
const ASN_856 = [
  "BSN*00*SHIP-TEST-1*20260108*1400",
  "DTM*011*20260108",
  "HL*1**S",
  "TD5**2*TSTC",
  "REF*BM*BOL-TEST-1",
  "REF*CN*TRACK-TEST-1",
  "HL*2*1*O",
  "PRF*PO-TEST-1001",
  "HL*3*2*I",
  "LIN**VN*STYLE-TEST-01*UP*000000000017",
  "SN1**2*EA",
  "HL*4*2*I",
  "LIN**VN*STYLE-TEST-02",
  "SN1**1*EA",
];
const INV_810 = ["BIG*20260108*INV-TEST-1*20260105*PO-TEST-1001", "ITD*01*3*****30", "IT1*1*2*EA*450.00**VN*STYLE-TEST-01", "IT1*2*1*EA*1250.50**VN*STYLE-TEST-02", "TDS*213050", "SAC*C*D240***1500", "SAC*A*C310***2000"];
const INV_846 = ["BIA*00*MM*INVRPT-TEST-1*20260109", "N1*RL*Test Store 1*92*STORE-01", "LIN**VN*STYLE-TEST-01", "QTY*17*3*EA", "QTY*33*2*EA", "LIN**UP*000000000024"];
const SALES_852 = ["XQ*H*20260101*20260107", "N1*RL*Test Retailer*92*CHAIN-01", "LIN**VN*STYLE-TEST-01", "ZA*QS**EA", "SDQ*EA*92*STORE-01*2*STORE-02*1", "ZA*QA*5*EA"];

const FILES = (): Record<string, string> => ({
  "inbound-0001.edi": interchange([{ set: "850", segments: PO_850 }], { control: "101" }),
  "inbound-0002.x12": interchange(
    [
      { set: "846", segments: INV_846 },
      { set: "852", segments: SALES_852 },
    ],
    { control: "102", functionalId: "IB" },
  ),
  "outbound-0001.edi": interchange(
    [
      { set: "855", segments: ACK_855 },
      { set: "856", segments: ASN_856 },
      { set: "810", segments: INV_810 },
    ],
    { from: BRAND, to: RETAILER, control: "201", functionalId: "PR" },
  ),
  "README.md": "not an EDI file",
});

function connector(source: FileSource = memoryFileSource(FILES()), extra: Partial<EdiX12Options> = {}) {
  return ediX12Connector({ source, now: NOW, batchSize: 4, ...extra });
}

async function collect(batches: AsyncIterable<SourceBatch>): Promise<SourceBatch[]> {
  const out: SourceBatch[] = [];
  for await (const b of batches) out.push(b);
  return out;
}

const eventsOf = async (c = connector()) => (await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events as EdiEvent[]);
const ofType = async (type: string, c = connector()) => (await eventsOf(c)).filter((e) => e.type === type);

const pipelineFor = () => testPipeline([], SCHEMAS);

describe("X12 reader", () => {
  it("reads the envelope, groups and sets, with delimiters taken from the ISA segment", () => {
    const text = `﻿${interchange([{ set: "850", segments: PO_850 }], { element: "|", segment: "\n", after: "" })}\r\n${interchange([{ set: "997", segments: ["AK1*PO*1"] }], { control: "2", after: "\r\n" })}`;
    const [first, second] = parseX12(text);
    expect(first).toMatchObject({ sender: { qualifier: "ZZ", id: RETAILER }, receiver: { qualifier: "ZZ", id: BRAND }, control: "000000001", usage: "P" });
    expect(first!.groups).toHaveLength(1);
    expect(first!.groups[0]).toMatchObject({ functionalId: "PO", control: "1", version: "004010" });
    const [po] = first!.groups[0]!.transactions;
    expect(po).toMatchObject({ set: "850", control: "0001", problems: [] });
    expect(po!.segments.map((s) => s.id)).toEqual(["BEG", "DTM", "N1", "N3", "PO1", "PO1", "CTT"]);
    expect(po!.segments[0]!.elements).toEqual(["00", "SA", "PO-TEST-1001", "", "20260105"]);
    expect(second!.groups[0]!.transactions[0]!.set).toBe("997");
    expect(parseX12("")).toEqual([]);
    expect(parseX12(" \n ")).toEqual([]);
  });

  it("keeps a set whose SE doesn't add up, with the problem named", () => {
    const [x] = parseX12(interchange([{ set: "850", segments: PO_850, seCount: 3, seControl: "9999" }]));
    expect(x!.groups[0]!.transactions[0]!.problems).toEqual(["SE in transaction 0001 says 3, found 9", "SE control number 9999, expected 0001"]);
  });

  it("rejects an envelope that doesn't add up, saying what is wrong", () => {
    const good = interchange([{ set: "850", segments: PO_850 }]);
    const cases: [string, RegExp][] = [
      ["GS*PO~", /expected an ISA segment at character 1/],
      [good.slice(0, 80), /shorter than 106/],
      [good.replace("*00401*", "*00401**"), /17 elements, expected 16/],
      [good.replace(/>~/, ">*"), /usable delimiters/],
      [good.replace(/IEA\*1\*000000001~\n$/, ""), /no IEA trailer/],
      [good.replace("IEA*1*000000001", "IEA*1*000000002"), /closes with IEA control number 000000002/],
      [good.replace("IEA*1*", "IEA*2*"), /IEA in interchange 000000001 says 2, found 1 functional groups/],
      [good.replace("GE*1*1", "GE*2*1"), /GE in group 1 says 2, found 1 transaction sets/],
      [good.replace("GE*1*1", "GE*1*7"), /group 1 closes with GE control number 7/],
      [good.replace(/SE\*9\*0001~\n/, ""), /transaction 0001 has no SE before GE/],
      [good.replace(/GE\*1\*1~\n/, ""), /group 1 has no GE/],
      [good.replace("ST*850*0001~", "BEG*00~\nST*850*0001~"), /BEG segment outside a transaction set/],
      [good.replace(/GS\*[^~]*~\n/, ""), /ST outside a functional group/],
      [good.replace("SE*9*0001~", "ST*850*0002~"), /transaction 0001 has no SE before the next ST/],
      [good.replace("ST*850", "GE*1*1~\nST*850"), /GE in group 1 says 1, found 0/],
      [good.replace("ST*850", "GS*PO*X*Y*20260110*1200*2*X*004010~\nST*850"), /group 1 has no GE before the next GS/],
      [good.replace(/SE\*9\*0001~\nGE\*1\*1~\n/, "GE*1*1~\n"), /transaction 0001 has no SE before GE/],
      [good.replace(/(GS\*[^~]*~\n)/, "$1SE*1*0009~\n"), /SE with no open transaction set/],
      [good.replace("GE*1*1~\n", "GE*1*1~\nGE*1*1~\n"), /GE with no open group/],
    ];
    for (const [text, message] of cases) expect(() => parseX12(text), String(message)).toThrow(message);
    expect(() => parseX12("GS*PO~")).toThrow(X12Error);
  });

  it("rejects an interchange cut off before its last segment ends", () => {
    const good = interchange([{ set: "850", segments: PO_850 }]);
    expect(() => parseX12(good.replace(/IEA\*1\*000000001~\n$/, "IEA*1*000000001"))).toThrow(/no IEA trailer/);
    expect(() => parseX12(`${good}${good.slice(0, 40)}`)).toThrow(/shorter than 106/);
  });
});

describe("EDI values", () => {
  it("reads dates, quantities and amounts exactly, returning null rather than guessing", () => {
    expect(x12Date("20260105")).toBe("2026-01-05");
    expect(x12Date("20240229")).toBe("2024-02-29");
    for (const bad of ["20250229", "20261301", "20260100", "20260230", "260105", "2026-01-05", "", "00990101"]) expect(x12Date(bad), bad).toBeNull();
    expect(x12Quantity("2")).toBe(2);
    expect(x12Quantity("2.5")).toBe(2.5);
    expect(x12Quantity("-1")).toBe(-1);
    for (const bad of ["", "two", "1,000", "1.", ".5"]) expect(x12Quantity(bad), bad).toBeNull();
    expect(x12Cents("450")).toBe(45000);
    expect(x12Cents("1250.5")).toBe(125050);
    expect(x12Cents("0.125")).toBe(13);
    expect(x12Cents("0.1249")).toBe(12);
    expect(x12Cents("-3.335")).toBe(-334);
    expect(x12Cents("-0.004")).toBe(0);
    expect(x12Cents("19.99")).toBe(1999);
    for (const bad of ["", "$5", "1,000.00", "abc"]) expect(x12Cents(bad), bad).toBeNull();
    expect(x12ImpliedCents("213050")).toBe(213050);
    expect(x12ImpliedCents("-500")).toBe(-500);
    for (const bad of ["", "2130.50", "x"]) expect(x12ImpliedCents(bad), bad).toBeNull();
  });

  it("reads product identifier pairs and picks the business's own item number", () => {
    const [x] = parseX12(interchange([{ set: "850", segments: ["PO1*1*1*EA*1**UP*000000000017*VN*STYLE-1*VN*STYLE-2*BP*BUYER-1*SK*"] }]));
    const ids = productIds(x!.groups[0]!.transactions[0]!.segments[0]!, 6);
    expect(ids).toEqual({ UP: "000000000017", VN: "STYLE-1", BP: "BUYER-1" });
    expect(skuOf(ids)).toBe("STYLE-1");
    expect(skuOf({ BP: "BUYER-1", SK: "SKU-1" })).toBe("SKU-1");
    expect(skuOf({ IN: "ITEM-1" })).toBe("ITEM-1");
    expect(skuOf({ VA: "A", VP: "P" })).toBe("A");
    expect(skuOf({ VP: "P", IN: "I" })).toBe("P");
    expect(skuOf({ UP: "000000000017" })).toBeUndefined();
  });

  it("names the partner on the far side: the sender of what partners send, the receiver of what was sent to them", () => {
    const [inbound] = parseX12(interchange([{ set: "850", segments: PO_850 }]));
    for (const set of ["850", "846", "852"] as const) expect(partnerOf(set, inbound!)).toBe(`ZZ:${RETAILER}`);
    for (const set of ["855", "856", "810"] as const) expect(partnerOf(set, inbound!)).toBe(`ZZ:${BRAND}`);
    expect(partnerOf("850", { ...inbound!, sender: { qualifier: "", id: "X" } })).toBe("ZZ:X");
  });
});

describe("EDI documents", () => {
  it("records a purchase order with its lines, prices and ship-to store, and no names or addresses", async () => {
    const [po] = await ofType("edi.purchase_order_received");
    expect(po).toEqual({
      id: expect.stringMatching(/^edi_ZZ:RETAILERTEST:850:PO-TEST-1001:[0-9a-f]{12}$/),
      type: "edi.purchase_order_received",
      occurredAt: "2026-01-05T00:00:00.000Z",
      receivedAt: RECEIVED,
      idempotencyKey: expect.stringMatching(/^edi:ZZ:RETAILERTEST:850:PO-TEST-1001:[0-9a-f]{12}$/),
      payload: {
        partnerId: "ZZ:RETAILERTEST",
        set: "850",
        poNumber: "PO-TEST-1001",
        purpose: "original",
        orderType: "SA",
        requestedDelivery: "2026-01-20",
        cancelAfter: undefined,
        shipTo: "92:STORE-01",
        lines: [
          { line: "1", sku: "STYLE-TEST-01", upc: "000000000017", ids: { VN: "STYLE-TEST-01", UP: "000000000017" }, quantity: 2, unit: "EA", unitPriceCents: 45000 },
          { line: "2", sku: "STYLE-TEST-02", ids: { VN: "STYLE-TEST-02" }, quantity: 1, unit: "EA", unitPriceCents: 125050 },
        ],
        totalCents: 215050,
        sourceDocument: "inbound-0001.edi:000000101:0001",
      },
    });
    expect(JSON.stringify(po)).not.toMatch(/Test Store 1|Test Street/);
  });

  it("reads a replacement order, a cancel-after date and a delivery date under its other qualifier", async () => {
    const segments = ["BEG*05*SA*PO-TEST-2*1*20260105", "DTM*010*20260121", "DTM*001*20260131", "PO1*1*1*EA**", "PO1*2*1*EA*5**SK*SKU-TEST-9"];
    const [po] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "850", segments: [...segments.slice(0, 3), "PO1*1*1*EA***VN*STYLE-TEST-01", segments[4]!] }]) })));
    expect(po!.payload).toMatchObject({ purpose: "replace", requestedDelivery: "2026-01-21", cancelAfter: "2026-01-31", totalCents: undefined });
    expect((po!.payload.lines as { unitPriceCents?: number }[]).map((l) => l.unitPriceCents)).toEqual([undefined, 500]);
    const [other] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "850", segments: ["BEG*01*SA*PO-TEST-3**20260105", "PO1*1*1*EA*1**VN*S"] }]) })));
    expect(other!.payload).toMatchObject({ purpose: "01", shipTo: undefined });
    const [blank] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "850", segments: ["BEG***PO-TEST-4**20260105", "PO1*1*1*EA*1**VN*S"] }]) })));
    expect(blank!.payload).toMatchObject({ purpose: undefined, orderType: undefined });
    // A line that names its product only by UPC is still readable: the business's catalog matches it.
    const [upcOnly] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "850", segments: ["BEG*00*SA*PO-TEST-5**20260105", "PO1*1*1*EA*1**UP*000000000024"] }]) })));
    expect(upcOnly!.occurredAt).toBe("2026-01-05T00:00:00.000Z");
    expect(upcOnly!.payload.lines).toEqual([{ line: "1", sku: null, upc: "000000000024", ids: { UP: "000000000024" }, quantity: 1, unit: "EA", unitPriceCents: 100 }]);
  });

  it("records an acknowledgment with each line's status", async () => {
    const [ack] = await ofType("edi.purchase_order_acknowledged");
    expect(ack!.occurredAt).toBe("2026-01-06T00:00:00.000Z");
    expect(ack!.payload).toMatchObject({ partnerId: "ZZ:RETAILERTEST", poNumber: "PO-TEST-1001", ackType: "AC", status: "accepted_with_changes" });
    expect((ack!.payload.lines as { sku: string; acks: unknown[] }[]).map((l) => [l.sku, l.acks])).toEqual([
      ["STYLE-TEST-01", [{ code: "IA", status: "accepted", quantity: 2, date: undefined }]],
      ["STYLE-TEST-02", [{ code: "IB", status: "backordered", quantity: 1, date: "2026-01-25" }]],
    ]);
  });

  it("dates an acknowledgment by its order date when it carries no date of its own, and reads rejections", async () => {
    const segments = ["BAK*00*RJ*PO-TEST-5*20260104", "PO1*1*1*EA*1**VN*S", "REF*ZZ*NOTE", "ACK*IR*1*EA", "ACK*ZZ", "PO1*2*1*EA*1**VN*T", "CTT*2", "ACK*IA*1"];
    const [ack] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "855", segments }], { from: BRAND, to: RETAILER }) })));
    expect(ack!.occurredAt).toBe("2026-01-04T00:00:00.000Z");
    expect(ack!.payload.status).toBe("rejected");
    expect((ack!.payload.lines as { acks: unknown[] }[]).map((l) => l.acks)).toEqual([
      [
        { code: "IR", status: "rejected", quantity: 1, date: undefined },
        { code: "ZZ", status: "other", quantity: undefined, date: undefined },
      ],
      [],
    ]);
    const [plain] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "855", segments: ["BAK*00*AK*PO-TEST-6*20260104", "PO1*1*1*EA*1**VN*S"] }]) })));
    expect(plain!.payload.status).toBe("accepted");
    const [none] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "855", segments: ["BAK*00**PO-TEST-7*20260104", "PO1*1*1*EA*1**VN*S"] }]) })));
    expect(none!.payload).toMatchObject({ ackType: undefined, status: undefined });
  });

  it("records a ship notice with carrier, tracking and each item under its order", async () => {
    const [asn] = await ofType("edi.shipment_noticed");
    expect(asn!.occurredAt).toBe("2026-01-08T00:00:00.000Z");
    expect(asn!.payload).toMatchObject({
      shipmentId: "SHIP-TEST-1",
      shippedOn: "2026-01-08",
      expectedOn: undefined,
      carrier: "TSTC",
      billOfLading: "BOL-TEST-1",
      trackingNumber: "TRACK-TEST-1",
      poNumbers: ["PO-TEST-1001"],
      lines: [
        { poNumber: "PO-TEST-1001", sku: "STYLE-TEST-01", upc: "000000000017", ids: { VN: "STYLE-TEST-01", UP: "000000000017" }, quantity: 2, unit: "EA" },
        { poNumber: "PO-TEST-1001", sku: "STYLE-TEST-02", ids: { VN: "STYLE-TEST-02" }, quantity: 1, unit: "EA" },
      ],
    });
  });

  it("keeps items of a multi-order shipment under the right order, and an order-less item without one", async () => {
    const segments = [
      "BSN*00*SHIP-TEST-2*20260108",
      "DTM*017*20260112",
      "HL*1**S",
      "HL*2*1*O",
      "PRF*PO-A",
      "HL*3*2*I",
      "LIN**VN*A1",
      "SN1**1",
      "HL*4*1*O",
      "HL*5*4*I",
      "LIN**VN*B1",
      "SN1**3*EA",
      "HL*6*1*O",
      "PRF*PO-C",
      "HL*7*6*P",
      "LIN**VN*IGNORED",
      "SN1**9*EA",
      "HL*8*7*I",
      "LIN**VN*C1",
      "SN1**2*EA",
    ];
    const [asn] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "856", segments }], { from: BRAND, to: RETAILER }) })));
    expect(asn!.payload).toMatchObject({ expectedOn: "2026-01-12", carrier: undefined, poNumbers: ["PO-A", "PO-C"] });
    expect((asn!.payload.lines as { poNumber?: string; sku: string; quantity: number; unit?: string }[]).map((l) => [l.poNumber, l.sku, l.quantity, l.unit])).toEqual([
      ["PO-A", "A1", 1, undefined],
      [undefined, "B1", 3, "EA"],
      ["PO-C", "C1", 2, "EA"],
    ]);
    const [alt] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "856", segments: ["BSN*00*S3*20260108", "DTM*067*20260113", "HL*1**I", "LIN**VN*A", "SN1**1"] }]) })));
    expect(alt!.payload.expectedOn).toBe("2026-01-13");
  });

  it("records an invoice with its total, charges, allowances and terms", async () => {
    const [inv] = await ofType("edi.invoice_sent");
    expect(inv!.occurredAt).toBe("2026-01-08T00:00:00.000Z");
    expect(inv!.payload).toMatchObject({
      invoiceNumber: "INV-TEST-1",
      poNumber: "PO-TEST-1001",
      shippedOn: undefined,
      netDays: 30,
      totalCents: 213050,
      charges: [
        { type: "charge", code: "D240", amountCents: 1500 },
        { type: "allowance", code: "C310", amountCents: 2000 },
      ],
    });
    expect((inv!.payload.lines as { sku: string; quantity: number; unitPriceCents: number }[]).map((l) => [l.sku, l.quantity, l.unitPriceCents])).toEqual([
      ["STYLE-TEST-01", 2, 45000],
      ["STYLE-TEST-02", 1, 125050],
    ]);
    const segments = ["BIG*20260108*INV-TEST-2", "DTM*011*20260107", "ITD*01*3", "IT1*1*1*EA*1**VN*S", "TDS*100", "SAC*N*X***1"];
    const [other] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "810", segments }]) })));
    expect(other!.payload).toMatchObject({ poNumber: undefined, shippedOn: "2026-01-07", netDays: undefined, charges: [{ type: "N", code: "X", amountCents: 1 }] });
    const [bare] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "810", segments: ["BIG*20260108*INV-TEST-3", "IT1*1*1*EA*1**VN*S", "TDS*100", "SAC*C"] }]) })));
    expect(bare!.occurredAt).toBeUndefined();
    expect(bare!.payload.problems).toEqual(["SAC05 amount is missing"]);
  });

  it("records a partner's inventory report by item and quantity code, at its location", async () => {
    const [report] = await ofType("edi.inventory_reported");
    expect(report!.occurredAt).toBe("2026-01-09T00:00:00.000Z");
    expect(report!.payload).toMatchObject({
      reportNumber: "INVRPT-TEST-1",
      location: "92:STORE-01",
      items: [
        { sku: "STYLE-TEST-01", ids: { VN: "STYLE-TEST-01" }, quantities: [{ code: "17", quantity: 3 }, { code: "33", quantity: 2 }] },
        { sku: null, upc: "000000000024", ids: { UP: "000000000024" }, quantities: [] },
      ],
    });
    // The second item has only a UPC, which the business's own catalog can still match, but it names no item number.
    expect(report!.idempotencyKey).toMatch(/^edi:ZZ:RETAILERTEST:846:/);
  });

  it("records sell-through by store, summing store quantities when the total is left out", async () => {
    const [sales] = await ofType("edi.sell_through_reported");
    expect(sales!.occurredAt).toBe("2026-01-07T00:00:00.000Z");
    expect(sales!.idempotencyKey).toMatch(/^edi:ZZ:RETAILERTEST:852:20260101-20260107:[0-9a-f]{12}$/);
    expect(sales!.payload).toMatchObject({
      periodStart: "2026-01-01",
      periodEnd: "2026-01-07",
      location: "92:CHAIN-01",
      items: [
        {
          sku: "STYLE-TEST-01",
          activity: [
            { code: "QS", quantity: 3, unit: "EA", byLocation: { "92:STORE-01": 2, "92:STORE-02": 1 } },
            { code: "QA", quantity: 5, unit: "EA" },
          ],
        },
      ],
    });
    const segments = ["XQ*H*20260107", "N1*ST*X*92*STORE-09", "LIN**VN*S", "ZA*QS*4", "SDQ*EA**STORE-01*1**7"];
    const [one] = await eventsOf(connector(memoryFileSource({ "a.edi": interchange([{ set: "852", segments }]) })));
    expect(one!.payload).toMatchObject({ periodStart: "2026-01-07", periodEnd: "2026-01-07", location: "92:STORE-09" });
    expect((one!.payload.items as { activity: unknown[] }[])[0]!.activity).toEqual([{ code: "QS", quantity: 4, unit: undefined, byLocation: { "ZZ:STORE-01": 1 } }]);
  });

  it("lists every problem in a document it can't read and leaves its time out, so the pipeline dead-letters it", async () => {
    const cases: [string, string[], string[]][] = [
      ["850", ["BEG*00*SA***2026010X", "PO1*1*two*EA*abc", "CTT*3"], ["PO1 line 1 quantity two can't be read", "PO1 line 1 unit price abc can't be read", "PO1 line 1 names no product", "CTT says 3 lines, found 1", "BEG03 purchase order number is missing", "BEG05 order date 2026010X is not a CCYYMMDD date"]],
      ["850", ["BEG*00*SA*PO-X"], ["no PO1 lines", "BEG05 order date is missing"]],
      ["855", ["BAK*00*AC*PO-X*20260105*****2026", "PO1*1*1*EA*1**VN*S", "ACK*IA*x"], ["ACK quantity for line 1 x can't be read", "BAK09 acknowledgment date 2026 is not a CCYYMMDD date"]],
      ["856", ["BSN*00**20260108", "HL*1**I", "SN1**x"], ["an item in the ship notice names no product", "SN1 shipped quantity for an item x can't be read", "BSN02 shipment id is missing"]],
      ["856", ["BSN*00*S*20260108", "HL*1**S"], ["no shipped items (HL item loops with SN1)"]],
      ["810", ["BIG*20260108*INV-X", "IT1*1**EA*1**VN*S"], ["IT1 line 1 quantity is missing", "TDS01 invoice total is missing"]],
      ["846", ["BIA*00*MM**20260109", "LIN*7*BP", "QTY*17*x"], ["LIN 7 names no product", "QTY 17 for an item x can't be read", "BIA03 report number is missing"]],
      ["846", ["BIA*00*MM*R*20260109"], ["no LIN items"]],
      ["852", ["XQ*H", "SDQ*EA*92*S1*1", "LIN**VN*S", "SDQ*EA*92*S1*1", "ZA*QS", "ZA*QA*x", "SDQ*EA*92*S1*y"], ["SDQ before any ZA for S", "ZA QA for S x can't be read", "SDQ quantity at S1 y can't be read", "ZA QS for S has no quantity", "XQ02 reporting period is missing", "XQ03 period end is missing"]],
    ];
    for (const [set, segments, problems] of cases) {
      const events = await eventsOf(connector(memoryFileSource({ "bad.edi": interchange([{ set, segments }]) })));
      expect(events, set).toHaveLength(1);
      expect(events[0]!.occurredAt, set).toBeUndefined();
      expect(events[0]!.payload.problems, `${set} ${segments[0]}`).toEqual(problems);
    }
  });

  it("dead-letters a set whose own trailer is wrong, keyed by its control numbers when it has no document number", async () => {
    const files = { "bad.edi": interchange([{ set: "850", segments: PO_850, seCount: 4 }, { set: "850", segments: ["BEG*00*SA"] }], { control: "55" }) };
    const events = await eventsOf(connector(memoryFileSource(files)));
    expect(events.map((e) => e.payload.problems)).toEqual([["SE in transaction 0001 says 4, found 9"], ["no PO1 lines", "BEG03 purchase order number is missing", "BEG05 order date is missing"]]);
    expect(events[1]!.idempotencyKey).toMatch(/^edi:ZZ:RETAILERTEST:850:control-000000055-0002:[0-9a-f]{12}$/);
  });
});

describe("EDI with retail partners connector", () => {
  it("uses only synthetic data in its fixtures", () => {
    assertSynthetic(FILES());
  });

  it("survives every runSync scenario", async () => {
    const result = await checkConnectorSync({ makeConnector: () => connector(), payloadSchemas: SCHEMAS, expected: { ingested: 6 } });
    // One purchase order, then 846 and 852, then 855, 856 and 810, each file its own batch at batchSize 4.
    expect(result.full.batches).toBe(3);
    expect(result.replay.duplicates).toBe(6);
    const cursor = JSON.parse(result.full.cursor!) as EdiCursor;
    expect(cursor.current).toBeNull();
    expect(Object.keys(cursor.done).sort()).toEqual(["inbound-0001.edi", "inbound-0002.x12", "outbound-0001.edi"]);
    expect(cursor.done["inbound-0001.edi"]).toBe(sha256(FILES()["inbound-0001.edi"]!));
  });

  it("dead-letters exactly the documents it can't read, keeping where each came from and why", async () => {
    const files = { ...FILES(), "inbound-0003.edi": interchange([{ set: "850", segments: ["BEG*00*SA*PO-TEST-BAD**20261399", "PO1*1*1*EA*1**VN*S"] }], { control: "103" }) };
    const { memory, pipeline } = pipelineFor();
    const report = await runSync({ connector: connector(memoryFileSource(files)), mode: "historical", pipeline, memory, organizationId: TEST_ORG });
    expect(report).toMatchObject({ ingested: 6, deadLettered: 1 });
    expect(memory.deadLetters.map((d) => [(d.raw as EdiEvent).payload.sourceDocument, (d.raw as EdiEvent).payload.problems, d.issues.map((i) => i.path)])).toEqual([
      ["inbound-0003.edi:000000103:0001", ["BEG05 order date 20261399 is not a CCYYMMDD date"], ["occurredAt"]],
    ]);
  });

  it("stores the same document sent again as a duplicate, and a changed one as new", async () => {
    const source = memoryFileSource(FILES());
    const { memory, pipeline } = pipelineFor();
    const sync = () => runSync({ connector: connector(source), mode: "incremental", pipeline, memory, organizationId: TEST_ORG });
    expect(await sync()).toMatchObject({ ingested: 6 });
    // The VAN delivers the same order again, in a new file with new control numbers.
    source.files["inbound-0004.edi"] = interchange([{ set: "850", segments: PO_850 }], { control: "104" });
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 1 });
    // A changed order is a new document.
    source.files["inbound-0005.edi"] = interchange([{ set: "850", segments: PO_850.map((s) => s.replace("PO1*2*1*", "PO1*2*3*")) }], { control: "105" });
    expect(await sync()).toMatchObject({ ingested: 1, duplicates: 0 });
    expect(await sync()).toMatchObject({ ingested: 0, duplicates: 0, batches: 0 });
  });

  it("skips test interchanges unless told to read them, and sets it doesn't read", async () => {
    const files = {
      "a.edi": interchange([{ set: "850", segments: PO_850 }], { usage: "T" }),
      "b.edi": interchange([{ set: "997", segments: ["AK1*PO*1", "AK9*A*1*1*1"] }, { set: "860", segments: ["BCH*01*SA*PO-TEST-1001**20260106"] }], { functionalId: "FA" }),
    };
    expect(await eventsOf(connector(memoryFileSource(files)))).toEqual([]);
    expect((await eventsOf(connector(memoryFileSource(files), { includeTest: true }))).map((e) => e.type)).toEqual(["edi.purchase_order_received"]);
  });

  it("honours historyYears, keeping documents on the cutoff and dropping older ones, but never drops one it can't read", async () => {
    const po = (date: string, n: string) => interchange([{ set: "850", segments: [`BEG*00*SA*PO-${n}**${date}`, "PO1*1*1*EA*1**VN*S"] }], { control: n });
    const files = { "1.edi": po("20240110", "1"), "2.edi": po("20240109", "2"), "3.edi": interchange([{ set: "850", segments: ["BEG*00*SA*PO-3**20200101"] }], { control: "3" }) };
    const events = await eventsOf(connector(memoryFileSource(files)));
    expect(events.map((e) => e.payload.poNumber)).toEqual(["PO-1", "PO-3"]);
    expect(events[1]!.payload.problems).toEqual(["no PO1 lines"]);
    expect((await eventsOf(connector(memoryFileSource(files), { historyYears: 5 }))).map((e) => e.payload.poNumber)).toEqual(["PO-1", "PO-2", "PO-3"]);
  });

  it("reads only X12 files, in name order", async () => {
    const one = interchange([{ set: "850", segments: PO_850 }]);
    const files = { "c.DAT": one.replace("PO-TEST-1001", "PO-C"), "a.txt": one.replace("PO-TEST-1001", "PO-A"), "b.X12": one.replace("PO-TEST-1001", "PO-B"), "d.csv": one, "e.edi.bak": one };
    expect((await eventsOf(connector(memoryFileSource(files)))).map((e) => e.payload.poNumber)).toEqual(["PO-A", "PO-B", "PO-C"]);
  });

  it("stops with the file named when its envelope is broken, and passes other failures through for runSync to retry", async () => {
    const broken = { ...FILES(), "inbound-0002.x12": FILES()["inbound-0002.x12"]!.replace("GE*2*102", "GE*3*102") };
    const error = await eventsOf(connector(memoryFileSource(broken))).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EdiFileError);
    expect((error as EdiFileError).file).toBe("inbound-0002.x12");
    expect((error as Error).message).toBe("inbound-0002.x12: GE in group 102 says 3, found 2 transaction sets");
    const outage: FileSource = { ...memoryFileSource(FILES()), read: async () => Promise.reject(new TypeError("disk went away")) };
    await expect(eventsOf(connector(outage))).rejects.toThrow(TypeError);
  });

  it("resumes an interrupted file where it stopped", async () => {
    const c = connector(memoryFileSource(FILES()), { batchSize: 1 });
    const batches = await collect(c.historicalImport({ organizationId: TEST_ORG, cursor: null }));
    expect(batches).toHaveLength(6);
    const midway = batches[3]!.cursor;
    expect(JSON.parse(midway)).toMatchObject({ current: { name: "outbound-0001.edi", next: 1 } });
    const rest = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: midway }))).flatMap((b) => b.events as EdiEvent[]);
    expect(rest.map((e) => e.type)).toEqual(["edi.shipment_noticed", "edi.invoice_sent"]);
  });

  it("runs the same way incrementally, takes no webhooks, and checks its batch size", async () => {
    const c = connector();
    const incremental = (await collect(c.incrementalSync({ organizationId: TEST_ORG, cursor: null }))).flatMap((b) => b.events);
    expect(incremental).toEqual(await eventsOf());
    expect(c.source).toBe("edi_x12");
    expect(c.handleWebhook).toBeUndefined();
    expect(Object.values(EDI_EVENT_TYPES).sort()).toEqual((await eventsOf()).map((e) => e.type).sort());
    expect(() => ediX12Connector({ source: memoryFileSource({}), batchSize: 0 })).toThrow(/batchSize/);
    expect(() => ediX12Connector({ source: memoryFileSource({}), batchSize: 1.5 })).toThrow(/batchSize/);
    // Two years of history by default: two years on, every fixture document is older than the cutoff.
    expect(await eventsOf(ediX12Connector({ source: memoryFileSource(FILES()), now: () => new Date("2028-01-10T00:00:00Z") }))).toHaveLength(0);
  });

  it("declares sending acknowledgments, ship notices and invoices, and a read-only gate blocks every one", async () => {
    const c = connector();
    expect(c.writes).toBe(EDI_X12_WRITES);
    const audit = await assertWritesRefused(c);
    expect(audit.map((a) => [a.action, a.outcome])).toEqual([
      ["send_po_acknowledgment", "refused"],
      ["send_ship_notice", "refused"],
      ["send_invoice", "refused"],
    ]);
  });

  it("rejects a checkpoint it didn't write", () => {
    const hash = sha256("x");
    expect(parseEdiCursor(null)).toBeNull();
    expect(parseEdiCursor(JSON.stringify({ done: { "a.edi": hash }, current: null }))).toMatchObject({ done: { "a.edi": hash } });
    for (const bad of ["null", "{}", JSON.stringify({ done: { "a.edi": "short" }, current: null })]) {
      expect(() => parseEdiCursor(bad), bad).toThrow(/EDI import checkpoint is not in the expected shape/);
    }
  });

  it("reads a real mailbox folder, skipping hidden files and subfolders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edi-import-"));
    await writeFile(join(dir, "inbound-0001.edi"), FILES()["inbound-0001.edi"]!);
    await writeFile(join(dir, ".inbound-0002.edi"), FILES()["inbound-0001.edi"]!.replace("PO-TEST-1001", "PO-HIDDEN"));
    await mkdir(join(dir, "archive.edi"));
    const events = await eventsOf(connector(directorySource(dir)));
    expect(events.map((e) => e.payload.poNumber)).toEqual(["PO-TEST-1001"]);
  });
});
