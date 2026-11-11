import { createHash } from "node:crypto";
import { quoTime } from "../openphone/normalize.js";

/**
 * Turns Cin7 Core records into Brain A events, in the types the store and
 * books connectors already give where one fits, so inventory, sales and
 * buying read Cin7 Core the same way:
 *
 * - `product.updated` for each product: its sku, name, category, brand,
 *   kind, unit, first price tier and average cost, and whether it is
 *   active;
 * - `customer.profile_updated` for each customer and
 *   `accounting.vendor_updated` for each supplier: the name, currency and
 *   whether they are active, never an address, contact, phone or email;
 * - `order.updated` for each sale and `accounting.purchase_order_updated`
 *   for each purchase: the number, customer or supplier, status, dates,
 *   total, what has been paid and what is still owed, and the currency;
 * - `inventory.counted` for each product at each location (and bin and
 *   batch, when Cin7 Core splits stock by them): on hand, allocated,
 *   available and on order.
 *
 * Cin7 Core writes times in UTC, so an event is dated by its record's
 * change time; a stock count is dated when it was read. Money becomes whole
 * cents in the record's currency. Each event is keyed by the record and a
 * digest of what was kept, so reading it again is a duplicate and a change
 * is a new event. A record that doesn't read (no id, no change time, stock
 * that isn't a whole count) is dead-lettered listing what was wrong.
 */

export interface Cin7Event {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface Cin7Context {
  receivedAt: string;
}

export type Cin7Read = { ok: boolean; event: Cin7Event };

const SYSTEM = "Cin7 Core";
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** Cin7 Core's ids are GUIDs, kept in lower case. */
const guid = (v: unknown) => (typeof v === "string" && /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(v) ? v.toLowerCase() : undefined);
const ref = (kind: string, v: unknown) => {
  const id = guid(v);
  return id === undefined ? undefined : `cin7:${kind}:${id}`;
};
/** Text Cin7 Core keeps, trimmed, without markup, up to `max` characters. */
const text = (v: unknown, max: number) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t !== "" && t.length <= max && !/[<>\p{Cc}]/u.test(t) ? t : undefined;
};
/** A sku or document number: no spaces or markup. */
const reference = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9#][A-Za-z0-9#_./:-]{0,59}$/.test(v) ? v : undefined);
/** A Cin7 Core status or kind, such as AUTHORISED or Stock, as snake case. */
const code = (v: unknown) => {
  const t = text(v, 60);
  return t && /^[A-Za-z][A-Za-z0-9 /-]*$/.test(t) ? t.toLowerCase().replace(/[ /-]+/g, "_") : undefined;
};
const currency = (v: unknown) => (typeof v === "string" && /^[A-Z]{3}$/.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : undefined);
/** A decimal Cin7 Core writes as a number. */
const decimal = (v: unknown) => (typeof v === "number" && Math.abs(v) <= 1e12 ? v : undefined);
/** A Cin7 Core amount in whole cents, or undefined when it doesn't read. */
export function cin7Cents(v: unknown): number | undefined {
  const n = decimal(v);
  return n === undefined ? undefined : Math.round(n * 100);
}

/** A Cin7 Core time, which is UTC with or without the Z, as an ISO time; null when it doesn't read. */
export function cin7Time(v: unknown): string | null {
  return typeof v === "string" ? quoTime(v.endsWith("Z") ? v : `${v}Z`) : null;
}
/** The day of a Cin7 Core date, which it may write as a time at midnight. */
const day = (v: unknown) => {
  const m = typeof v === "string" ? /^(\d{4}-\d\d-\d\d)(T\d\d:\d\d:\d\d(\.\d{1,7})?Z?)?$/.exec(v) : null;
  return m && quoTime(`${m[1]}T00:00:00Z`) ? m[1] : undefined;
};

function read(kind: string, type: string, raw: unknown, problems: string[], id: string | undefined, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): Cin7Read {
  const ok = problems.length === 0;
  const key = ok ? `cin7:${kind}:${id}:${short(payload)}` : `cin7:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? occurredAt : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, kind, id: id ?? null, problems },
    },
  };
}

/** The checks every record with a change time shares: an object, its id and its change time. */
function header(kind: string, raw: unknown, idField: string, changedField: string) {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push(`${kind} is not an object`);
  const id = guid(r[idField]);
  if (!id) problems.push(`${kind} has no id that reads`);
  const changedAt = cin7Time(r[changedField]) ?? undefined;
  if (!changedAt) problems.push(`${kind} has no change time that reads`);
  return { r, problems, id, changedAt };
}

export function cin7ProductEvent(raw: unknown, ctx: Cin7Context): Cin7Read {
  const { r, problems, id, changedAt } = header("product", raw, "ID", "LastModifiedOn");
  const sku = reference(r.SKU);
  if (!sku) problems.push("product has no sku that reads");
  const payload = {
    system: SYSTEM,
    productId: `cin7:product:${id}`,
    sku,
    name: text(r.Name, 200),
    category: text(r.Category, 100),
    brand: text(r.Brand, 100),
    kind: code(r.Type),
    unit: text(r.UOM, 50),
    priceCents: cin7Cents(r.PriceTier1),
    averageCostCents: cin7Cents(r.AverageCost),
    active: r.Status !== "Deprecated",
    changedAt,
  };
  return read("product", "product.updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}

/** A customer or supplier: who they are to the business, never how to reach them. */
function party(kind: "customer" | "supplier", type: string, idName: string, raw: unknown, ctx: Cin7Context): Cin7Read {
  const { r, problems, id, changedAt } = header(kind, raw, "ID", "LastModifiedOn");
  const payload = {
    system: SYSTEM,
    [idName]: `cin7:${kind}:${id}`,
    name: text(r.Name, 256) ?? `Cin7 Core ${kind} ${id}`,
    currency: currency(r.Currency),
    active: r.Status !== "Deprecated",
    changedAt,
  };
  return read(kind, type, raw, problems, id, payload, changedAt, ctx.receivedAt);
}

export const cin7CustomerEvent = (raw: unknown, ctx: Cin7Context) => party("customer", "customer.profile_updated", "customerId", raw, ctx);
export const cin7SupplierEvent = (raw: unknown, ctx: Cin7Context) => party("supplier", "accounting.vendor_updated", "vendorId", raw, ctx);

/** What an order's total and paid amounts say, and what is still owed. */
function money(total: unknown, paid: unknown) {
  const totalCents = cin7Cents(total);
  const paidCents = cin7Cents(paid);
  return { totalCents, paidCents, balanceCents: totalCents === undefined || paidCents === undefined ? undefined : totalCents - paidCents };
}

export function cin7SaleEvent(raw: unknown, ctx: Cin7Context): Cin7Read {
  const { r, problems, id, changedAt } = header("sale", raw, "SaleID", "Updated");
  const payload = {
    system: SYSTEM,
    orderId: `cin7:sale:${id}`,
    number: reference(r.OrderNumber),
    invoiceNumber: reference(r.InvoiceNumber),
    customerId: ref("customer", r.CustomerID),
    status: code(r.Status),
    orderDate: day(r.OrderDate),
    invoiceDate: day(r.InvoiceDate),
    dueDate: day(r.InvoiceDueDate),
    ...money(r.InvoiceAmount, r.PaidAmount),
    currency: currency(r.CustomerCurrency),
    changedAt,
  };
  return read("sale", "order.updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}

export function cin7PurchaseEvent(raw: unknown, ctx: Cin7Context): Cin7Read {
  const { r, problems, id, changedAt } = header("purchase", raw, "ID", "LastUpdatedDate");
  const payload = {
    system: SYSTEM,
    purchaseOrderId: `cin7:purchase:${id}`,
    number: reference(r.OrderNumber),
    invoiceNumber: reference(r.InvoiceNumber),
    vendorId: ref("supplier", r.SupplierID),
    status: code(r.Status),
    orderDate: day(r.OrderDate),
    requiredBy: day(r.RequiredBy),
    dueDate: day(r.InvoiceDueDate),
    ...money(r.InvoiceAmount, r.PaidAmount),
    currency: currency(r.SupplierCurrency),
    changedAt,
  };
  return read("purchase", "accounting.purchase_order_updated", raw, problems, id, payload, changedAt, ctx.receivedAt);
}

export function cin7StockEvent(raw: unknown, ctx: Cin7Context): Cin7Read {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push("stock is not an object");
  const product = guid(r.ID);
  const location = text(r.Location, 256);
  if (!product || !location) problems.push("stock has no product and location that read");
  const sku = reference(r.SKU);
  if (!sku) problems.push("stock's product has no sku that reads");
  const onHand = decimal(r.OnHand);
  if (!Number.isSafeInteger(onHand) || onHand! < 0) problems.push("stock on hand isn't a whole count of zero or more");
  const bin = text(r.Bin, 100);
  const batch = text(r.Batch, 100);
  const payload = {
    system: SYSTEM,
    sku,
    onHand,
    productId: `cin7:product:${product}`,
    location,
    bin,
    batch,
    allocated: decimal(r.Allocated),
    available: decimal(r.Available),
    onOrder: decimal(r.OnOrder),
  };
  // Cin7 Core splits a product's stock at a location by bin and batch, so each split is its own count.
  const id = product && location ? `${product}_${short([location, bin ?? null, batch ?? null])}` : undefined;
  return read("stock", "inventory.counted", raw, problems, id, payload, ctx.receivedAt, ctx.receivedAt);
}
