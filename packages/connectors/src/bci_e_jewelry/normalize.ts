import { createHash } from "node:crypto";
import { EJEWELRY_TIME } from "./client.js";

/**
 * Turns Business Central rows from an e-Jewelry tenant into Brain A events,
 * in the vendor-neutral types the NetSuite, QuickBooks and Xero connectors
 * use, so finance, buying and inventory read e-Jewelry's books the same way:
 *
 * - `accounting.item_updated` for each item: its number as the sku, name,
 *   kind, whether it is blocked, price, cost and what is on hand;
 * - `accounting.vendor_updated` for each vendor: its name, currency, what
 *   is owed to it and whether it is blocked;
 * - `accounting.invoice_updated` for each sales invoice: its number, the
 *   customer's id (never their name, address, email or phone), dates,
 *   total, what is still owed, currency and status;
 * - `accounting.bill_updated` for each purchase invoice: its number, the
 *   vendor's id and invoice number, dates, total, currency and status.
 *
 * Business Central writes change times in UTC, so an event is dated when
 * the row last changed. Money becomes whole cents in the document's
 * currency, which is the company's own when Business Central leaves it
 * blank. Each event is keyed by the row and a digest of what was kept, so
 * reading it again is a duplicate and a change is a new event. A row that
 * doesn't read (no id, no change time, an unknown kind) is dead-lettered
 * listing what was wrong.
 */

export interface EJewelryEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface EJewelryContext {
  receivedAt: string;
}

export type EJewelryRead = { ok: boolean; event: EJewelryEvent };

const SYSTEM = "e-Jewelry";
const PREFIX = "bci_e_jewelry";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Business Central's item types, as the kinds the other connectors use. */
const KINDS = new Map([
  ["Inventory", "inventory"],
  ["Service", "service"],
  ["Non-Inventory", "non_inventory"],
]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A Business Central id: a GUID, kept in lower case. */
const guid = (v: unknown) => {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return GUID.test(s) ? s : undefined;
};
const ref = (kind: string, v: unknown) => {
  const id = guid(v);
  return id === undefined ? undefined : `${PREFIX}:${kind}:${id}`;
};
/** Text Business Central keeps, trimmed, without markup, up to `max` characters. */
const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t !== "" && t.length <= max && !/[<>\p{Cc}]/u.test(t) ? t : undefined;
};
/** A number, sku or code: no spaces or markup. */
const reference = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9#][A-Za-z0-9#_./:-]{0,59}$/.test(v) ? v : undefined);
/** A status, such as In Review, as snake case. */
const code = (v: unknown) => {
  const t = text(v, 40);
  return t && /^[A-Za-z][A-Za-z ]*$/.test(t) ? t.toLowerCase().replace(/ +/g, "_") : undefined;
};
/** A day; Business Central writes 0001-01-01 for none. */
const day = (v: unknown) => {
  if (typeof v !== "string" || !/^(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) return undefined;
  return new Date(`${v}T00:00:00Z`).toISOString().startsWith(v) ? v : undefined;
};
/** A currency code; blank is the company's own, which Business Central doesn't name. */
const currency = (v: unknown) => (typeof v === "string" && /^[A-Z]{3}$/.test(v) ? v : undefined);
/** A decimal Business Central writes as a number. */
const decimal = (v: unknown) => (typeof v === "number" && Math.abs(v) <= 1e12 ? v : undefined);

/** A Business Central amount in whole cents, or undefined when it doesn't read. */
export function eJewelryCents(v: unknown): number | undefined {
  const n = decimal(v);
  return n === undefined ? undefined : Math.round(n * 100);
}

/** A change time as an ISO moment, or undefined when it isn't a real UTC time. */
export function eJewelryInstant(v: unknown): string | undefined {
  if (typeof v !== "string" || !EJEWELRY_TIME.test(v)) return undefined;
  const at = new Date(v);
  // A day past the month's end rolls over into the next month.
  return at.getUTCDate() === Number(v.slice(8, 10)) ? at.toISOString() : undefined;
}

function read(kind: string, type: string, raw: unknown, problems: string[], id: string | undefined, payload: Record<string, unknown>, changedAt: string | undefined, receivedAt: string): EJewelryRead {
  const ok = problems.length === 0;
  const key = ok ? `${PREFIX}:${kind}:${id}:${short(payload)}` : `${PREFIX}:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? changedAt : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, kind, id: id ?? null, problems },
    },
  };
}

/** The checks every row shares. */
function header(kind: string, raw: unknown) {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push(`${kind} is not an object`);
  const id = guid(r.id);
  if (!id) problems.push(`${kind} has no id that reads`);
  const changedAt = eJewelryInstant(r.lastModifiedDateTime);
  if (!changedAt) problems.push(`${kind} has no change time that reads`);
  return { r, problems, id, changedAt };
}

export function eJewelryItemEvent(raw: unknown, ctx: EJewelryContext): EJewelryRead {
  const { r, problems, id, changedAt } = header("item", raw);
  const kind = KINDS.get(r.type as string);
  if (!kind) problems.push("item is not a kind KaratOS reads");
  const payload = {
    system: SYSTEM,
    itemId: `${PREFIX}:item:${id}`,
    sku: reference(r.number),
    name: text(r.displayName, 200),
    kind,
    category: reference(r.itemCategoryCode),
    active: r.blocked === false,
    unitPriceCents: eJewelryCents(r.unitPrice),
    unitCostCents: eJewelryCents(r.unitCost),
    onHand: decimal(r.inventory),
    unit: reference(r.baseUnitOfMeasureCode),
    changedAt,
  };
  return read("item", "accounting.item_updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}

export function eJewelryVendorEvent(raw: unknown, ctx: EJewelryContext): EJewelryRead {
  const { r, problems, id, changedAt } = header("vendor", raw);
  const owed = eJewelryCents(r.balance);
  const payload = {
    system: SYSTEM,
    vendorId: `${PREFIX}:vendor:${id}`,
    number: reference(r.number),
    name: text(r.displayName, 200) ?? `e-Jewelry vendor ${id}`,
    currency: currency(r.currencyCode),
    balanceCents: owed,
    // Business Central writes a blank for a vendor that isn't blocked.
    active: typeof r.blocked === "string" && r.blocked.trim() === "",
    changedAt,
  };
  return read("vendor", "accounting.vendor_updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}

export function eJewelryInvoiceEvent(raw: unknown, ctx: EJewelryContext): EJewelryRead {
  const { r, problems, id, changedAt } = header("invoice", raw);
  const payload = {
    system: SYSTEM,
    invoiceId: `${PREFIX}:sales_invoice:${id}`,
    customerId: ref("customer", r.customerId),
    number: reference(r.number),
    txnDate: day(r.invoiceDate),
    dueDate: day(r.dueDate),
    totalCents: eJewelryCents(r.totalAmountIncludingTax),
    taxCents: eJewelryCents(r.totalTaxAmount),
    balanceCents: eJewelryCents(r.remainingAmount),
    currency: currency(r.currencyCode),
    status: code(r.status),
    changedAt,
  };
  return read("invoice", "accounting.invoice_updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}

export function eJewelryBillEvent(raw: unknown, ctx: EJewelryContext): EJewelryRead {
  const { r, problems, id, changedAt } = header("bill", raw);
  const payload = {
    system: SYSTEM,
    billId: `${PREFIX}:purchase_invoice:${id}`,
    vendorId: ref("vendor", r.vendorId),
    number: reference(r.number),
    vendorInvoiceNumber: reference(r.vendorInvoiceNumber),
    txnDate: day(r.invoiceDate),
    dueDate: day(r.dueDate),
    totalCents: eJewelryCents(r.totalAmountIncludingTax),
    taxCents: eJewelryCents(r.totalTaxAmount),
    currency: currency(r.currencyCode),
    status: code(r.status),
    changedAt,
  };
  return read("bill", "accounting.bill_updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}
