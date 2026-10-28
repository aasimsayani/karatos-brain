import { createHash } from "node:crypto";
import { el, type X12Interchange, type X12Segment, type X12Transaction } from "./x12.js";

/**
 * Turns the X12 documents exchanged with a retail partner into Brain A
 * events. Purchase orders (850), inventory (846) and sell-through (852)
 * come from the partner; acknowledgements (855), ship notices (856) and
 * invoices (810) are the copies of what the business sent. Each becomes one
 * event, keyed by the document number and its content, so a document sent
 * twice is a duplicate and a changed one is new. A document that can't be
 * read is kept with its problems listed and no occurredAt, so the pipeline
 * dead-letters it. Only identifiers and quantities are read: names and
 * street addresses in N1 to N4 are skipped.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface EdiEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface DocumentContext {
  interchange: X12Interchange;
  transaction: X12Transaction;
  /** The file the document came from. */
  file: string;
  receivedAt: string;
  /** Documents dated before this ISO time are skipped. */
  since: string;
}

/** The transaction sets this connector reads, and the event each becomes. */
export const EDI_EVENT_TYPES = {
  "850": "edi.purchase_order_received",
  "855": "edi.purchase_order_acknowledged",
  "856": "edi.shipment_noticed",
  "810": "edi.invoice_sent",
  "846": "edi.inventory_reported",
  "852": "edi.sell_through_reported",
} as const;
export type EdiSet = keyof typeof EDI_EVENT_TYPES;

/** Sets the partner sends; the partner is the interchange sender. For the rest, the business sent them and the partner is the receiver. */
const FROM_PARTNER: readonly EdiSet[] = ["850", "846", "852"];

export const isEdiSet = (set: string): set is EdiSet => Object.hasOwn(EDI_EVENT_TYPES, set);

/** A CCYYMMDD date as YYYY-MM-DD, or null when it isn't a real date. */
export function x12Date(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** An X12 decimal (R type), such as "2" or "12.50", or null. */
export function x12Quantity(value: string): number | null {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}

/** A decimal amount (R type, "1234.5") in cents, half-cents rounded away from zero, without floating point. */
export function x12Cents(value: string): number | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const fraction = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  return m[1] === "-" && cents !== 0 ? -cents : cents;
}

/** An amount with two implied decimals (N2 type, "123450" is 1234.50) in cents. */
export function x12ImpliedCents(value: string): number | null {
  return /^-?\d+$/.test(value) ? Number(value) : null;
}

/** Product identifiers from qualifier and value pairs starting at element `from`, such as PO106/PO107 or LIN02/LIN03. */
export function productIds(segment: X12Segment, from: number): Record<string, string> {
  const ids: Record<string, string> = {};
  for (let n = from; n < segment.elements.length; n += 2) {
    const qualifier = el(segment, n);
    const id = el(segment, n + 1);
    if (qualifier && id && !(qualifier in ids)) ids[qualifier] = id;
  }
  return ids;
}

/** The business's own item number, from the vendor's style or item number, else the SKU the partner used. */
export function skuOf(ids: Record<string, string>): string | undefined {
  return ids.VN ?? ids.VA ?? ids.VP ?? ids.SK ?? ids.BP ?? ids.IN;
}

const UPC_QUALIFIERS = ["UP", "UK", "EN"] as const;
const upcOf = (ids: Record<string, string>) => UPC_QUALIFIERS.map((q) => ids[q]).find((v) => v !== undefined);

function item(ids: Record<string, string>) {
  const upc = upcOf(ids);
  return { sku: skuOf(ids) ?? null, ...(upc ? { upc } : {}), ids };
}

const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const qualifier = (q: string) => q || "ZZ";

/** Reads a set's documents. Each reader fills problems for anything it can't read. */
interface Read {
  number: string;
  date: string | null;
  payload: Record<string, unknown>;
}

type Reader = (segments: X12Segment[], problems: string[]) => Read;

const find = (segments: X12Segment[], id: string, code?: string) => segments.find((s) => s.id === id && (code === undefined || el(s, 1) === code));

function required(value: string, what: string, problems: string[]): string {
  if (!value) problems.push(`${what} is missing`);
  return value;
}

function dated(value: string, what: string, problems: string[]): string | null {
  const date = x12Date(value);
  if (!date) problems.push(value ? `${what} ${value} is not a CCYYMMDD date` : `${what} is missing`);
  return date;
}

function amount<T>(value: T | null, raw: string, what: string, problems: string[]): T | null {
  if (value === null) problems.push(raw ? `${what} ${raw} can't be read` : `${what} is missing`);
  return value;
}

/** A DTM date with this qualifier, such as 002 (delivery requested) or 011 (shipped). */
const dtm = (segments: X12Segment[], code: string) => x12Date(el(find(segments, "DTM", code), 2)) ?? undefined;

/** The location code of an N1 party, such as the ship-to store; never its name. */
function location(segments: X12Segment[], role: string): string | undefined {
  const n1 = find(segments, "N1", role);
  return el(n1, 4) ? `${qualifier(el(n1, 3))}:${el(n1, 4)}` : undefined;
}

/** A PO1 or IT1 line: quantity, unit, price and products. */
function orderLine(segment: X12Segment, problems: string[]) {
  const where = `${segment.id} line ${el(segment, 1) || "?"}`;
  const ids = productIds(segment, 6);
  const line = {
    line: el(segment, 1) || undefined,
    ...item(ids),
    quantity: amount(x12Quantity(el(segment, 2)), el(segment, 2), `${where} quantity`, problems),
    unit: el(segment, 3) || undefined,
    unitPriceCents: el(segment, 4) ? amount(x12Cents(el(segment, 4)), el(segment, 4), `${where} unit price`, problems) : undefined,
  };
  if (line.sku === null && !line.upc) problems.push(`${where} names no product`);
  return line;
}

function lines(segments: X12Segment[], id: string, problems: string[]) {
  const found = segments.filter((s) => s.id === id).map((s) => orderLine(s, problems));
  if (found.length === 0) problems.push(`no ${id} lines`);
  return found;
}

/** Checks a CTT line count, when the document has one. */
function lineCount(segments: X12Segment[], count: number, problems: string[]) {
  const ctt = find(segments, "CTT");
  if (ctt && el(ctt, 1) !== String(count)) problems.push(`CTT says ${el(ctt, 1)} lines, found ${count}`);
}

const total = (ls: { quantity: number | null; unitPriceCents?: number | null | undefined }[]) =>
  ls.every((l) => l.quantity !== null && typeof l.unitPriceCents === "number") ? Math.round(ls.reduce((sum, l) => sum + l.quantity! * (l.unitPriceCents as number), 0)) : undefined;

const ACK_STATUS: Record<string, string> = {
  IA: "accepted",
  AR: "accepted",
  IC: "accepted_with_changes",
  IP: "price_changed",
  IQ: "quantity_changed",
  IS: "substituted",
  IB: "backordered",
  IR: "rejected",
  ID: "deleted",
};

const READERS: Record<EdiSet, Reader> = {
  "850"(segments, problems) {
    const beg = find(segments, "BEG");
    const ls = lines(segments, "PO1", problems);
    lineCount(segments, ls.length, problems);
    return {
      number: required(el(beg, 3), "BEG03 purchase order number", problems),
      date: dated(el(beg, 5), "BEG05 order date", problems),
      payload: {
        poNumber: el(beg, 3),
        purpose: el(beg, 1) === "00" ? "original" : el(beg, 1) === "05" ? "replace" : el(beg, 1) || undefined,
        orderType: el(beg, 2) || undefined,
        requestedDelivery: dtm(segments, "002") ?? dtm(segments, "010"),
        cancelAfter: dtm(segments, "001"),
        shipTo: location(segments, "ST"),
        lines: ls,
        totalCents: total(ls),
      },
    };
  },

  "855"(segments, problems) {
    const bak = find(segments, "BAK");
    const ls: Record<string, unknown>[] = [];
    for (const [i, s] of segments.entries()) {
      if (s.id !== "PO1") continue;
      const acks = [];
      for (const next of segments.slice(i + 1)) {
        if (next.id !== "ACK") {
          if (next.id === "PO1" || next.id === "CTT") break;
          continue;
        }
        acks.push({
          code: el(next, 1),
          status: ACK_STATUS[el(next, 1)] ?? "other",
          quantity: el(next, 2) ? amount(x12Quantity(el(next, 2)), el(next, 2), `ACK quantity for line ${el(s, 1) || "?"}`, problems) : undefined,
          date: x12Date(el(next, 5)) ?? undefined,
        });
      }
      ls.push({ ...orderLine(s, problems), acks });
    }
    lineCount(segments, ls.length, problems);
    return {
      number: required(el(bak, 3), "BAK03 purchase order number", problems),
      date: el(bak, 9) ? dated(el(bak, 9), "BAK09 acknowledgment date", problems) : dated(el(bak, 4), "BAK04 order date", problems),
      payload: {
        poNumber: el(bak, 3),
        ackType: el(bak, 2) || undefined,
        status: el(bak, 2) === "RJ" ? "rejected" : el(bak, 2) === "AC" ? "accepted_with_changes" : el(bak, 2) ? "accepted" : undefined,
        lines: ls,
      },
    };
  },

  "856"(segments, problems) {
    const bsn = find(segments, "BSN");
    const td5 = find(segments, "TD5");
    const shipped: Record<string, unknown>[] = [];
    const orders = new Set<string>();
    let po: string | undefined;
    let ids: Record<string, string> | null = null;
    for (const s of segments) {
      if (s.id === "HL") {
        if (el(s, 3) === "O") po = undefined;
        ids = el(s, 3) === "I" ? {} : null;
      } else if (s.id === "PRF") {
        po = el(s, 1) || undefined;
        if (po) orders.add(po);
      } else if (s.id === "LIN" && ids) {
        Object.assign(ids, productIds(s, 2));
      } else if (s.id === "SN1" && ids) {
        const what = `SN1 shipped quantity for ${skuOf(ids) ?? "an item"}`;
        if (!skuOf(ids) && !upcOf(ids)) problems.push("an item in the ship notice names no product");
        shipped.push({ poNumber: po, ...item(ids), quantity: amount(x12Quantity(el(s, 2)), el(s, 2), what, problems), unit: el(s, 3) || undefined });
      }
    }
    if (shipped.length === 0) problems.push("no shipped items (HL item loops with SN1)");
    return {
      number: required(el(bsn, 2), "BSN02 shipment id", problems),
      date: dated(el(bsn, 3), "BSN03 notice date", problems),
      payload: {
        shipmentId: el(bsn, 2),
        shippedOn: dtm(segments, "011"),
        expectedOn: dtm(segments, "017") ?? dtm(segments, "067"),
        carrier: el(td5, 3) || undefined,
        billOfLading: el(find(segments, "REF", "BM"), 2) || undefined,
        trackingNumber: el(find(segments, "REF", "CN"), 2) || undefined,
        poNumbers: [...orders],
        lines: shipped,
      },
    };
  },

  "810"(segments, problems) {
    const big = find(segments, "BIG");
    const tds = find(segments, "TDS");
    const ls = lines(segments, "IT1", problems);
    const charges = segments
      .filter((s) => s.id === "SAC")
      .map((s) => ({
        type: el(s, 1) === "A" ? "allowance" : el(s, 1) === "C" ? "charge" : el(s, 1),
        code: el(s, 2) || undefined,
        amountCents: amount(x12ImpliedCents(el(s, 5)), el(s, 5), "SAC05 amount", problems),
      }));
    const netDays = el(find(segments, "ITD"), 7);
    return {
      number: required(el(big, 2), "BIG02 invoice number", problems),
      date: dated(el(big, 1), "BIG01 invoice date", problems),
      payload: {
        invoiceNumber: el(big, 2),
        poNumber: el(big, 4) || undefined,
        shippedOn: dtm(segments, "011"),
        netDays: /^\d+$/.test(netDays) ? Number(netDays) : undefined,
        lines: ls,
        charges,
        totalCents: amount(x12ImpliedCents(el(tds, 1)), el(tds, 1), "TDS01 invoice total", problems),
      },
    };
  },

  "846"(segments, problems) {
    const bia = find(segments, "BIA");
    const items = itemLoops(segments, problems, (s, current) => {
      if (s.id !== "QTY") return;
      current.quantities.push({ code: el(s, 1), quantity: amount(x12Quantity(el(s, 2)), el(s, 2), `QTY ${el(s, 1)} for ${current.sku ?? "an item"}`, problems) });
    });
    return {
      number: required(el(bia, 3), "BIA03 report number", problems),
      date: dated(el(bia, 4), "BIA04 report date", problems),
      payload: { reportNumber: el(bia, 3), location: location(segments, "RL") ?? location(segments, "WH"), items: items.map(({ activity: _a, ...rest }) => rest) },
    };
  },

  "852"(segments, problems) {
    const xq = find(segments, "XQ");
    // Activity whose ZA leaves the quantity out, for the store quantities in its SDQ segments to add up to.
    const byStores = new Set<ItemLoop["activity"][number]>();
    const items = itemLoops(segments, problems, (s, current) => {
      if (s.id === "ZA") {
        const what = `ZA ${el(s, 1)} for ${current.sku ?? "an item"}`;
        const activity = { code: el(s, 1), quantity: el(s, 2) ? amount(x12Quantity(el(s, 2)), el(s, 2), what, problems) : null, unit: el(s, 3) || undefined };
        if (!el(s, 2)) byStores.add(activity);
        current.activity.push(activity);
      } else if (s.id === "SDQ") {
        const last = current.activity[current.activity.length - 1];
        if (!last) return void problems.push(`SDQ before any ZA for ${current.sku ?? "an item"}`);
        const byLocation = (last.byLocation ??= {});
        for (let n = 3; n < s.elements.length; n += 2) {
          const store = el(s, n);
          if (!store) continue;
          const quantity = amount(x12Quantity(el(s, n + 1)), el(s, n + 1), `SDQ quantity at ${store}`, problems);
          if (quantity !== null) byLocation[`${qualifier(el(s, 2))}:${store}`] = quantity;
        }
      }
    });
    for (const i of items) {
      for (const a of i.activity) {
        if (!byStores.has(a)) continue;
        const stores = Object.values(a.byLocation ?? {});
        if (stores.length) a.quantity = stores.reduce((x, y) => x + y, 0);
        else problems.push(`ZA ${a.code} for ${i.sku ?? "an item"} has no quantity`);
      }
    }
    const start = el(xq, 2);
    const end = el(xq, 3) || start;
    return {
      number: start && end ? `${start}-${end}` : required("", "XQ02 reporting period", problems),
      date: dated(end, "XQ03 period end", problems),
      payload: { periodStart: x12Date(start) ?? undefined, periodEnd: x12Date(end) ?? undefined, location: location(segments, "RL") ?? location(segments, "ST"), items: items.map(({ quantities: _q, ...rest }) => rest) },
    };
  },
};

interface ItemLoop {
  sku: string | null;
  upc?: string;
  ids: Record<string, string>;
  quantities: { code: string; quantity: number | null }[];
  activity: { code: string; quantity: number | null; unit?: string | undefined; byLocation?: Record<string, number> }[];
}

/** The LIN loops of an 846 or 852: each LIN starts an item, and the segments after it belong to it. */
function itemLoops(segments: X12Segment[], problems: string[], each: (segment: X12Segment, current: ItemLoop) => void): ItemLoop[] {
  const items: ItemLoop[] = [];
  for (const s of segments) {
    if (s.id === "LIN") {
      const loop: ItemLoop = { ...item(productIds(s, 2)), quantities: [], activity: [] };
      if (loop.sku === null && !loop.upc) problems.push(`LIN ${el(s, 1) || "?"} names no product`);
      items.push(loop);
    } else if (items.length) {
      each(s, items[items.length - 1]!);
    }
  }
  if (items.length === 0) problems.push("no LIN items");
  return items;
}

/** The trading partner on the other side of a document: the sender of what partners send, the receiver of what the business sent. */
export function partnerOf(set: EdiSet, interchange: X12Interchange): string {
  const party = FROM_PARTNER.includes(set) ? interchange.sender : interchange.receiver;
  return `${qualifier(party.qualifier)}:${party.id}`;
}

/** One document as an event, or null when it is dated before the history cutoff. */
export function documentEvent(set: EdiSet, ctx: DocumentContext): EdiEvent | null {
  const problems = [...ctx.transaction.problems];
  const read = READERS[set](ctx.transaction.segments, problems);
  const partner = partnerOf(set, ctx.interchange);
  const occurredAt = read.date ? `${read.date}T00:00:00.000Z` : undefined;
  if (occurredAt && problems.length === 0 && occurredAt < ctx.since) return null;
  const content = short(ctx.transaction.segments.map((s) => [s.id, ...s.elements].join("*")).join("~"));
  const key = `${partner}:${set}:${read.number || `control-${ctx.interchange.control}-${ctx.transaction.control}`}:${content}`;
  return {
    id: `edi_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`,
    type: EDI_EVENT_TYPES[set],
    occurredAt: problems.length ? undefined : occurredAt,
    receivedAt: ctx.receivedAt,
    idempotencyKey: `edi:${key}`,
    payload: {
      partnerId: partner,
      set,
      ...read.payload,
      sourceDocument: `${ctx.file}:${ctx.interchange.control}:${ctx.transaction.control}`,
      ...(problems.length ? { problems } : {}),
    },
  };
}
