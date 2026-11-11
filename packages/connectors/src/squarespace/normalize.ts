import { createHash, createHmac } from "node:crypto";

/**
 * Turns a Squarespace store's products, stock and orders into Brain A
 * events, so a jeweler whose website runs on Squarespace gets the same
 * online sales picture a Shopify store does.
 *
 * - A product becomes `product.updated`, with its type, name, whether it is
 *   on sale on the site, and each variant's SKU, price, sale price and
 *   stock.
 * - A stock line becomes `inventory.counted`, with the variant's SKU and
 *   quantity (null when stock isn't tracked), dated when it was read.
 * - An order becomes `order.updated`, with its number, channel, fulfillment
 *   and payment states, money in cents, its lines (product, variant, SKU,
 *   quantity, unit price) and the customer under a keyed reference.
 *
 * Each is keyed by its record and a digest of what was kept, so one read
 * again unchanged is a duplicate. Never kept: the customer's email, names,
 * addresses and phone numbers, line customizations (they can hold an
 * engraving), form answers and internal notes. A record without an ID or a
 * time that reads is dead-lettered listing what was wrong.
 */

export interface SquarespaceEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface SquarespaceContext {
  receivedAt: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
}

export const SQUARESPACE_EVENTS = { product: "product.updated", stock: "inventory.counted", order: "order.updated" } as const;

// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PRODUCT_TYPES = new Set(["PHYSICAL", "SERVICE", "GIFT_CARD", "DIGITAL"]);
const FULFILLMENT = new Set(["PENDING", "FULFILLED", "CANCELED"]);
const PAYMENT = new Set(["NOT_CHARGED", "AUTHORIZED", "PAID", "REFUNDED", "PENDING", "FAILED", "REFUND_PENDING", "REFUND_FAILED", "PARTIALLY_PAID"]);
const LINE_TYPES = new Set(["PHYSICAL_PRODUCT", "SERVICE_PRODUCT", "GIFT_CARD", "DIGITAL_PRODUCT", "PAYWALL_PRODUCT"]);

const short = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
// Anything but an object reads as a record without the fields asked for.
const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const idOf = (v: unknown): string | undefined => (typeof v === "string" && ID.test(v) ? v : undefined);
const ref = (kind: string, id: string | undefined) => (id === undefined ? null : `squarespace:${kind}:${id}`);
/** A word from Squarespace's list, lowercased, or "other" for one it doesn't list, or null. */
const word = (known: Set<string>, v: unknown): string | null => (typeof v === "string" ? (known.has(v) ? v.toLowerCase() : "other") : null);
const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** A Squarespace time as a UTC ISO time, or undefined. */
export function squarespaceTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}${m[4]}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** A MonetaryAmount's value (a number, or a decimal string) in whole cents, or null. Half a cent rounds away from zero. */
export function squarespaceCents(amount: unknown): number | null {
  const raw = obj(amount).value;
  const v = typeof raw === "string" && /^-?\d{1,12}(\.\d{1,6})?$/.test(raw) ? Number(raw) : raw;
  if (typeof v !== "number" || !(Math.abs(v) < 1e12)) return null;
  const cents = Math.round(Math.abs(v) * 100);
  return v < 0 ? -cents : cents;
}

const currencyOf = (amount: unknown): string | null => {
  const c = obj(amount).currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
};

/** A keyed reference for a Squarespace customer ID, the same on every order of that customer. */
export function squarespaceCustomerRef(key: string, customerId: string): string {
  return `squarespace_customer:${createHmac("sha256", key).update(`squarespace_customer:${customerId}`, "utf8").digest("hex").slice(0, 32)}`;
}

function make(kind: string, type: string, id: string | undefined, problems: string[], raw: unknown, occurredAt: string | undefined, payload: Record<string, unknown>, ctx: SquarespaceContext): SquarespaceEvent {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `squarespace:${kind}:${id}:${short(payload)}` : `squarespace:unreadable_${kind}:${short(raw)}`;
  return { id: idempotencyKey.replace(/:/g, "_"), type, occurredAt: ok ? occurredAt : undefined, receivedAt: ctx.receivedAt, idempotencyKey, payload: ok ? payload : { system: "Squarespace", problems } };
}

/** A product's product.updated, with its variants. */
export function squarespaceProductEvent(raw: unknown, ctx: SquarespaceContext): SquarespaceEvent {
  const r = obj(raw);
  const id = idOf(r.id);
  const updatedAt = squarespaceTime(r.modifiedOn);
  const problems = [...(id ? [] : ["product has no ID that reads"]), ...(updatedAt ? [] : ["product has no time that reads"])];
  const variants = list(r.variants).map((x) => {
    const variant = obj(x);
    const pricing = obj(variant.pricing);
    const stock = obj(variant.stock);
    return {
      variantId: ref("variant", idOf(variant.id)),
      sku: text(variant.sku, 60),
      priceCents: squarespaceCents(pricing.basePrice),
      salePriceCents: squarespaceCents(pricing.salePrice),
      onSale: flag(pricing.onSale),
      stock: count(stock.quantity),
      unlimited: flag(stock.unlimited),
    };
  });
  const payload = {
    system: "Squarespace",
    productId: ref("product", id),
    type: word(PRODUCT_TYPES, r.type),
    name: text(r.name, 200),
    visible: flag(r.isVisible),
    storePageId: ref("store_page", idOf(r.storePageId)),
    currency: currencyOf(obj(obj(list(r.variants)[0]).pricing).basePrice),
    variants,
    createdAt: squarespaceTime(r.createdOn) ?? null,
    updatedAt,
  };
  return make("product", SQUARESPACE_EVENTS.product, id, problems, raw, updatedAt, payload, ctx);
}

/** A stock line's inventory.counted, dated when it was read. */
export function squarespaceStockEvent(raw: unknown, ctx: SquarespaceContext): SquarespaceEvent {
  const r = obj(raw);
  const id = idOf(r.variantId);
  const unlimited = flag(r.isUnlimited);
  const payload = {
    system: "Squarespace",
    sku: text(r.sku, 60),
    // Untracked stock has no count; its last known amount isn't one.
    onHand: unlimited === false ? count(r.quantity) : null,
    unlimited,
    variantId: ref("variant", id),
    locationId: "squarespace:store",
  };
  return make("stock", SQUARESPACE_EVENTS.stock, id, id ? [] : ["stock line has no variant ID that reads"], raw, ctx.receivedAt, payload, ctx);
}

/** An order's order.updated. */
export function squarespaceOrderEvent(raw: unknown, ctx: SquarespaceContext): SquarespaceEvent {
  const r = obj(raw);
  const id = idOf(r.id);
  const updatedAt = squarespaceTime(r.modifiedOn);
  const problems = [...(id ? [] : ["order has no ID that reads"]), ...(updatedAt ? [] : ["order has no time that reads"])];
  const customer = idOf(r.customerId);
  const lines = list(r.lineItems).map((x) => {
    const line = obj(x);
    return {
      lineId: ref("line", idOf(line.id)),
      productId: ref("product", idOf(line.productId)),
      variantId: ref("variant", idOf(line.variantId)),
      sku: text(line.sku, 60),
      name: text(line.productName, 200),
      type: word(LINE_TYPES, line.lineItemType),
      quantity: count(line.quantity),
      unitPriceCents: squarespaceCents(line.unitPricePaid),
    };
  });
  const payload = {
    system: "Squarespace",
    orderId: ref("order", id),
    orderNumber: text(r.orderNumber, 40),
    channel: text(r.channel, 40),
    channelName: text(r.channelName, 60),
    fulfillment: word(FULFILLMENT, r.fulfillmentStatus),
    payment: word(PAYMENT, r.paymentState),
    testMode: flag(r.testmode),
    currency: currencyOf(r.grandTotal),
    subtotalCents: squarespaceCents(r.subtotal),
    discountCents: squarespaceCents(r.discountTotal),
    shippingCents: squarespaceCents(r.shippingTotal),
    taxCents: squarespaceCents(r.taxTotal),
    totalCents: squarespaceCents(r.grandTotal),
    refundedCents: squarespaceCents(r.refundedTotal),
    lines,
    // The customer's email, names, addresses and phone stay in Squarespace; only a keyed reference is kept.
    customerId: customer ? squarespaceCustomerRef(ctx.customerKey, customer) : null,
    createdAt: squarespaceTime(r.createdOn) ?? null,
    fulfilledAt: squarespaceTime(r.fulfilledOn) ?? null,
    updatedAt,
  };
  return make("order", SQUARESPACE_EVENTS.order, id, problems, raw, updatedAt, payload, ctx);
}
