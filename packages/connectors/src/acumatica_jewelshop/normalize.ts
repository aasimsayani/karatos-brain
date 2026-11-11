import { createHash, createHmac } from "node:crypto";

/**
 * Turns Acumatica (JewelShop) records into Brain A events.
 *
 * - A stock item becomes `product.updated`, with its SKU, description,
 *   class, status, type, unit and default price.
 * - Each of its warehouse lines becomes `inventory.counted`: what that
 *   warehouse has on hand, dated when it was read, since a quantity can
 *   change without the item's LastModified moving.
 * - A sales order becomes `order.updated`, with its type, number, status,
 *   date, currency, total and quantity, and the customer under a keyed
 *   reference.
 *
 * Each is keyed by its record and a digest of what was kept, so reading one
 * again unchanged is a duplicate. Never kept: a customer's own account code
 * (only a reference keyed with the instance's CUSTOMER_REF_KEY), contacts, addresses or notes. Money is whole
 * cents. A record without an ID or a time that reads is dead-lettered
 * listing what was wrong.
 *
 * Acumatica writes each field as { "value": ... }.
 */

export interface AcumaticaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface AcumaticaContext {
  receivedAt: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
}

export const ACUMATICA_EVENTS = { item: "product.updated", stock: "inventory.counted", order: "order.updated" } as const;

// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/;
/** An inventory ID, warehouse, order type or number: Acumatica keys may hold spaces and segment marks. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,59}$/;

const short = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A field's value, unwrapped from { value }. */
const field = (r: Record<string, unknown>, name: string): unknown => obj(r[name]).value;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const keyOf = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return KEY.test(t) ? t : undefined;
};
const ref = (kind: string, id: string) => `acumatica:${kind}:${id.toLowerCase()}`;
const quantity = (v: unknown): number | null => (Number.isFinite(v) && Math.abs(v as number) < 1e12 ? (v as number) : null);

/** A keyed reference for an Acumatica customer account code, the same on every order of that customer. */
export function acumaticaCustomerRef(key: string, code: string): string {
  return `acumatica_customer:${createHmac("sha256", key).update(`acumatica_customer:${code.toLowerCase()}`, "utf8").digest("hex").slice(0, 32)}`;
}

/** An Acumatica time as a UTC ISO time, or undefined. One without a zone isn't read, since it would be the instance's own zone. */
export function acumaticaTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  // Node cuts seven fraction digits, as .NET writes them, to the millisecond.
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}${m[4]}`);
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** A decimal amount, as Acumatica writes it (a number), in whole cents, or null. Half a cent rounds away from zero. */
export function acumaticaCents(v: unknown): number | null {
  if (!Number.isFinite(v) || Math.abs(v as number) >= 1e12) return null;
  const cents = Math.round(Math.abs(v as number) * 100);
  return (v as number) < 0 ? -cents : cents;
}

function make(kind: string, type: string, key: string | null, problems: string[], raw: unknown, occurredAt: string | undefined, payload: Record<string, unknown>, ctx: AcumaticaContext): AcumaticaEvent {
  const idempotencyKey = problems.length === 0 && key ? `acumatica:${kind}:${key}:${short(payload)}` : `acumatica:unreadable_${kind}:${short(raw)}`;
  return { id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"), type, occurredAt, receivedAt: ctx.receivedAt, idempotencyKey, payload: problems.length ? { system: "Acumatica", problems } : payload };
}

/** A stock item's product.updated, then an inventory.counted for each warehouse line that reads. */
export function acumaticaItemEvents(raw: unknown, ctx: AcumaticaContext): AcumaticaEvent[] {
  const r = obj(raw);
  const sku = keyOf(field(r, "InventoryID"));
  const updatedAt = acumaticaTime(field(r, "LastModified"));
  const problems = [...(sku ? [] : ["stock item has no inventory ID that reads"]), ...(updatedAt ? [] : ["stock item has no time that reads"])];
  const product = make(
    "item",
    ACUMATICA_EVENTS.item,
    sku ? sku.toLowerCase() : null,
    problems,
    raw,
    updatedAt,
    {
      system: "Acumatica",
      productId: sku && ref("item", sku),
      sku,
      title: text(field(r, "Description"), 120),
      itemClass: text(field(r, "ItemClass"), 40),
      status: text(field(r, "ItemStatus"), 40),
      itemType: text(field(r, "ItemType"), 40),
      unit: text(field(r, "BaseUOM"), 20),
      priceCents: acumaticaCents(field(r, "DefaultPrice")),
      updatedAt,
    },
    ctx,
  );
  if (!sku) return [product];
  const lines = Array.isArray(r.WarehouseDetails) ? r.WarehouseDetails.map(obj) : [];
  const counts = lines.flatMap((line) => {
    const warehouse = keyOf(field(line, "WarehouseID"));
    if (!warehouse) return [];
    // A fractional or negative quantity is kept as Acumatica reports it, so the inventory schema dead-letters it.
    const payload = { system: "Acumatica", sku, onHand: quantity(field(line, "QtyOnHand")), variantId: ref("item", sku), locationId: ref("warehouse", warehouse) };
    return [make("stock", ACUMATICA_EVENTS.stock, `${sku.toLowerCase()}:${warehouse.toLowerCase()}`, [], line, ctx.receivedAt, payload, ctx)];
  });
  return [product, ...counts];
}

/** A sales order's order.updated. */
export function acumaticaOrderEvent(raw: unknown, ctx: AcumaticaContext): AcumaticaEvent {
  const r = obj(raw);
  const type = keyOf(field(r, "OrderType"));
  const number = keyOf(field(r, "OrderNbr"));
  const updatedAt = acumaticaTime(field(r, "LastModified"));
  const problems = [...(type && number ? [] : ["sales order has no type and number that read"]), ...(updatedAt ? [] : ["sales order has no time that reads"])];
  const customer = keyOf(field(r, "CustomerID"));
  const currency = field(r, "CurrencyID");
  const id = type && number ? `${type}/${number}` : null;
  return make(
    "order",
    ACUMATICA_EVENTS.order,
    id && id.toLowerCase(),
    problems,
    raw,
    updatedAt,
    {
      system: "Acumatica",
      orderId: id && ref("order", id),
      orderType: type,
      orderNumber: number,
      status: text(field(r, "Status"), 40),
      createdAt: acumaticaTime(field(r, "Date")) ?? null,
      currency: typeof currency === "string" && /^[A-Z]{3}$/.test(currency) ? currency : null,
      totalCents: acumaticaCents(field(r, "OrderTotal")),
      quantity: quantity(field(r, "OrderedQty")),
      // The account code can name the business, so only its keyed reference is kept.
      customerId: customer ? acumaticaCustomerRef(ctx.customerKey, customer) : null,
      updatedAt,
    },
    ctx,
  );
}
