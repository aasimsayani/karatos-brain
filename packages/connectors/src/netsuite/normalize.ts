import { createHash } from "node:crypto";
import { NETSUITE_TIME } from "./client.js";

/**
 * Turns NetSuite rows into Brain A events, in the vendor-neutral types the
 * QuickBooks and Xero connectors use where one fits, so finance, buying and
 * inventory read NetSuite's books the same way:
 *
 * - `accounting.item_updated` for each item: its sku, name, kind and
 *   whether it is active;
 * - `accounting.vendor_updated` for each vendor: its company name (never a
 *   person's name), currency and whether it is active;
 * - `accounting.sales_order_updated`, `accounting.purchase_order_updated`,
 *   `accounting.invoice_updated` and `accounting.journal_entry_updated` for
 *   each transaction of those kinds: its number, customer or vendor, date,
 *   due date, total and what is still owed, currency and status;
 * - `inventory.counted` for each item at each location: on hand, available,
 *   committed, on order and back ordered.
 *
 * NetSuite writes times in the account's own time zone, so a row's change
 * time is kept as NetSuite wrote it (`changedAt`) and the event is dated
 * when it was read. Money becomes whole cents in the transaction's
 * currency. Each event is keyed by the row and a digest of what was kept,
 * so reading it again is a duplicate and a change is a new event. A row
 * that doesn't read (no id, no change time, an unknown kind, stock that
 * isn't a count) is dead-lettered listing what was wrong.
 */

export interface NetSuiteEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface NetSuiteContext {
  receivedAt: string;
}

export type NetSuiteRead = { ok: boolean; event: NetSuiteEvent };

const SYSTEM = "NetSuite";
/** Each transaction kind read, as the event it becomes and what its id and other party are called. */
const TRANSACTIONS = new Map<string, { type: string; id: string; party: [string, string] | null }>([
  ["SalesOrd", { type: "accounting.sales_order_updated", id: "salesOrderId", party: ["customerId", "customer"] }],
  ["PurchOrd", { type: "accounting.purchase_order_updated", id: "purchaseOrderId", party: ["vendorId", "vendor"] }],
  ["CustInvc", { type: "accounting.invoice_updated", id: "invoiceId", party: ["customerId", "customer"] }],
  ["Journal", { type: "accounting.journal_entry_updated", id: "journalEntryId", party: null }],
]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A NetSuite internal id: SuiteQL writes them as digits, as a string or a number. */
const internalId = (v: unknown) => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  return typeof s === "string" && /^-?\d{1,12}$/.test(s) ? s : undefined;
};
const ref = (kind: string, v: unknown) => {
  const id = internalId(v);
  return id === undefined ? undefined : `netsuite:${kind}:${id}`;
};
/** Text NetSuite keeps, trimmed, without markup, up to `max` characters. */
const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t !== "" && t.length <= max && !/[<>\p{Cc}]/u.test(t) ? t : undefined;
};
/** A sku or document number: no spaces or markup. */
const reference = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9#][A-Za-z0-9#_./:-]{0,59}$/.test(v) ? v : undefined);
/** A NetSuite code, such as InvtPart or Pending Billing, as snake case. */
const code = (v: unknown) => {
  const t = text(v, 60);
  return t && /^[A-Za-z][A-Za-z0-9 /-]*$/.test(t) ? t.toLowerCase().replace(/[ /-]+/g, "_") : undefined;
};
const flag = (v: unknown) => (v === "T" || v === true ? true : v === "F" || v === false ? false : undefined);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) ? v : undefined);
const currency = (v: unknown) => (typeof v === "string" && /^[A-Z]{3}$/.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : undefined);
/** A decimal SuiteQL writes as a number or a string. */
const decimal = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,13}(\.\d{1,8})?$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= 1e12 ? n : undefined;
};

/** A NetSuite amount in whole cents, or undefined when it doesn't read. */
export function netSuiteCents(v: unknown): number | undefined {
  const n = decimal(v);
  return n === undefined ? undefined : Math.round(n * 100);
}

/** A quantity that is a whole count of zero or more. */
const count = (v: unknown) => {
  const n = decimal(v);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

function read(kind: string, type: string, raw: unknown, problems: string[], id: string | undefined, payload: Record<string, unknown>, receivedAt: string): NetSuiteRead {
  const ok = problems.length === 0;
  const key = ok ? `netsuite:${kind}:${id}:${short(payload)}` : `netsuite:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? receivedAt : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, kind, id: id ?? null, problems },
    },
  };
}

/** The checks every row with a change time shares. */
function header(kind: string, raw: unknown) {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push(`${kind} is not an object`);
  const id = internalId(r.id);
  if (!id) problems.push(`${kind} has no id that reads`);
  const changedAt = typeof r.modified === "string" && NETSUITE_TIME.test(r.modified) ? r.modified : undefined;
  if (!changedAt) problems.push(`${kind} has no change time that reads`);
  return { r, problems, id, changedAt };
}

export function netSuiteItemEvent(raw: unknown, ctx: NetSuiteContext): NetSuiteRead {
  const { r, problems, id, changedAt } = header("item", raw);
  const payload = {
    system: SYSTEM,
    itemId: `netsuite:item:${id}`,
    sku: reference(r.itemid),
    name: text(r.displayname, 200),
    kind: code(r.itemtype),
    active: flag(r.isinactive) === false,
    changedAt,
  };
  return read("item", "accounting.item_updated", raw, problems, id, payload, ctx.receivedAt);
}

export function netSuiteVendorEvent(raw: unknown, ctx: NetSuiteContext): NetSuiteRead {
  const { r, problems, id, changedAt } = header("vendor", raw);
  // A vendor who is a person is never named.
  const company = flag(r.isperson) === false ? text(r.companyname, 200) : undefined;
  const payload = {
    system: SYSTEM,
    vendorId: `netsuite:vendor:${id}`,
    name: company ?? `NetSuite vendor ${id}`,
    currency: currency(r.currency),
    active: flag(r.isinactive) === false,
    changedAt,
  };
  return read("vendor", "accounting.vendor_updated", raw, problems, id, payload, ctx.receivedAt);
}

export function netSuiteTransactionEvent(raw: unknown, ctx: NetSuiteContext): NetSuiteRead {
  const { r, problems, id, changedAt } = header("transaction", raw);
  const kind = TRANSACTIONS.get(r.type as string);
  if (!kind) problems.push("transaction is not a kind KaratOS reads");
  const total = netSuiteCents(r.foreigntotal);
  const owed = netSuiteCents(r.foreignamountremaining);
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    [kind?.id ?? "transactionId"]: `netsuite:transaction:${id}`,
    ...(kind?.party ? { [kind.party[0]]: ref(kind.party[1], r.entity) } : {}),
    number: reference(r.tranid),
    txnDate: day(r.trandate),
    dueDate: day(r.duedate),
    totalCents: total === undefined ? undefined : Math.abs(total),
    balanceCents: owed === undefined ? undefined : Math.abs(owed),
    currency: currency(r.currency),
    status: code(r.status),
    changedAt,
  };
  return read("transaction", kind?.type ?? "accounting.transaction_updated", raw, problems, id, payload, ctx.receivedAt);
}

export function netSuiteStockEvent(raw: unknown, ctx: NetSuiteContext): NetSuiteRead {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push("stock is not an object");
  const item = internalId(r.item);
  const location = internalId(r.location);
  if (!item || !location) problems.push("stock has no item and location that read");
  const sku = reference(r.itemid);
  if (!sku) problems.push("stock's item has no sku that reads");
  const onHand = count(r.quantityonhand ?? 0);
  if (onHand === undefined) problems.push("stock on hand isn't a count of zero or more");
  const payload = {
    system: SYSTEM,
    sku,
    onHand,
    itemId: `netsuite:item:${item}`,
    locationId: `netsuite:location:${location}`,
    available: decimal(r.quantityavailable),
    committed: decimal(r.quantitycommitted),
    onOrder: decimal(r.quantityonorder),
    backOrdered: decimal(r.quantitybackordered),
  };
  return read("stock", "inventory.counted", raw, problems, item && location ? `${item}_${location}` : undefined, payload, ctx.receivedAt);
}
