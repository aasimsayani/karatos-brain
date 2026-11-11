import { createHash } from "node:crypto";

/**
 * Whatnot orders and products as Brain A events, in the types and shapes
 * the Etsy and eBay connectors give, so a sale in a live show reads like
 * any other:
 *
 * - order.updated: an order's latest state, for each change;
 * - sale.completed once an order is ready to fulfill, completed or
 *   cancelled, keyed by order so a later change never counts it twice, with
 *   channel "event" for a sale in a live show and "online" otherwise;
 * - sale.returned once an order is cancelled, keyed by order, so a cancelled
 *   sale nets to zero whether or not it was seen before it was cancelled;
 * - product.updated for each product with its variants;
 * - inventory.counted for each variant's available quantity.
 *
 * Only what the departments use is kept: no buyer id, username or display
 * name, no item or product descriptions, no media, and no dashboard links.
 *
 * Whatnot writes money as a decimal string in major units, "42" or "49.77",
 * with an ISO 4217 currency alongside; it is kept as whole cents. A record
 * that doesn't read is dead-lettered listing what was wrong, never guessed.
 */

export interface WhatnotEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type WhatnotRead = { ok: boolean; event: WhatnotEvent };

const SYSTEM = "Whatnot";
const ORDER_ID = /^[1-9][0-9]{0,18}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Whatnot's order statuses, as order.updated names them. */
const STATUSES = new Map<string, string>([
  ["pending", "PENDING"],
  ["pending_fulfillment", "PENDING_FULFILLMENT"],
  ["completed", "COMPLETED"],
  ["cancelled", "CANCELLED"],
  ["failed", "FAILED"],
]);
/** Statuses that are a sale: the buyer paid, whether or not it was later cancelled. */
const SOLD = new Set(["pending_fulfillment", "completed", "cancelled"]);
const TRANSACTION_TYPES = new Set(["buy_it_now", "auction", "giveaway", "other"]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

export const whatnotRef = (kind: string, id: string) => `whatnot:${kind}:${id}`;

/** An id Whatnot gave, or undefined. */
export function whatnotId(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/** An order id: a numeric string, as the docs give its pattern. */
export function whatnotOrderId(value: unknown): string | undefined {
  return typeof value === "string" && ORDER_ID.test(value) ? value : undefined;
}

/** An ISO 8601 time with a zone, as an ISO time, or undefined. */
export function whatnotTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A Money object as whole cents and its currency, or undefined when either doesn't read. */
export function whatnotMoney(value: unknown): { cents: number; currency: string } | undefined {
  const m = obj(value);
  if (typeof m.amount !== "string" || !AMOUNT.test(m.amount) || typeof m.currency !== "string" || !CURRENCY.test(m.currency)) return undefined;
  const [whole, fraction = ""] = m.amount.split(".");
  return { cents: Number(whole) * 100 + Number(fraction.padEnd(2, "0")), currency: m.currency };
}

/** A line's or variant's SKU: the seller's own, or a stable stand-in from the variant or product it sold from. */
export function whatnotSku(sku: unknown, variantId: unknown, productId: unknown): string | undefined {
  const own = text(sku, 100);
  if (own) return own;
  const variant = whatnotId(variantId);
  if (variant) return `whatnot-variant-${variant}`;
  const product = whatnotId(productId);
  return product && `whatnot-product-${product}`;
}

function read(kind: string, type: string, raw: unknown, problems: string[], key: string, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): WhatnotRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `whatnot:${kind}:${key}` : `whatnot:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? occurredAt : undefined,
      receivedAt,
      idempotencyKey,
      payload: ok ? payload : { system: SYSTEM, kind, problems },
    },
  };
}

interface SaleLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}

/** An order's line items as sale lines, or what was wrong with them. */
function linesOf(items: readonly unknown[], currency: string | undefined): { lines: SaleLine[]; problems: string[] } {
  const lines: SaleLine[] = [];
  const problems: string[] = [];
  items.forEach((raw, i) => {
    const item = obj(raw);
    const at = `line ${i + 1}`;
    if (item !== raw) return void problems.push(`${at} is not an object`);
    const sku = whatnotSku(obj(item.purchased_item).sku, item.variant_id, item.product_id);
    const quantity = Number.isSafeInteger(item.quantity) && (item.quantity as number) > 0 ? (item.quantity as number) : undefined;
    const price = whatnotMoney(item.unit_price);
    if (!sku) problems.push(`${at} has no SKU, variant or product that reads`);
    if (quantity === undefined) problems.push(`${at} has no quantity that reads`);
    if (!price) problems.push(`${at} has no unit price that reads`);
    else if (price.currency !== currency) problems.push(`${at} is not in the order's currency`);
    if (sku && quantity !== undefined && price && price.currency === currency) lines.push({ sku, quantity, unitPriceCents: price.cents, discountCents: 0 });
  });
  if (items.length === 0) problems.push("order has no line items");
  return { lines, problems };
}

/**
 * The events for one order and its line items (every page of them): the
 * order's state, then the sale once it is sold, then the return once it is
 * cancelled. An order that doesn't read is one dead letter; a sold order
 * whose lines don't all read keeps its order.updated and dead-letters the sale.
 */
export function whatnotOrderEvents(raw: unknown, items: readonly unknown[], receivedAt: string): WhatnotRead[] {
  const o = obj(raw);
  const problems: string[] = [];
  if (o !== raw) problems.push("order is not an object");
  const id = whatnotOrderId(o.id);
  if (!id) problems.push("order has no id that reads");
  const rawStatus = typeof o.status === "string" && STATUSES.has(o.status) ? o.status : undefined;
  if (!rawStatus) problems.push("order has no status that reads");
  const amounts = obj(o.amounts);
  const total = whatnotMoney(amounts.total);
  if (!total) problems.push("order has no total that reads");
  const createdAt = whatnotTime(o.created_at);
  const updatedAt = whatnotTime(o.updated_at);
  const cancelledAt = whatnotTime(o.cancelled_at);
  if (!createdAt && !updatedAt) problems.push("order has no time that reads");
  const sameCurrency = (m: unknown) => {
    const money = whatnotMoney(m);
    return money && money.currency === total?.currency ? money.cents : undefined;
  };
  const showId = whatnotId(o.show_id);
  const channel = showId ? "event" : "online";
  const { lines, problems: lineProblems } = linesOf(items, total?.currency);
  const orderId = whatnotRef("order", id ?? "");
  const status = rawStatus ? STATUSES.get(rawStatus) : undefined;

  const order = read(
    "order",
    "order.updated",
    raw,
    problems,
    `${id}:${rawStatus}:${updatedAt ?? createdAt}`,
    defined({
      system: SYSTEM,
      orderId,
      createdAt,
      status,
      paid: rawStatus === "pending_fulfillment" || rawStatus === "completed",
      // Whatnot says to fulfill pending_fulfillment orders; completed is taken to mean fulfilled.
      shipped: rawStatus === "completed",
      cancelled: rawStatus === "cancelled",
      cancelledAt,
      channel,
      marketplace: "whatnot",
      transactionType: typeof o.transaction_type === "string" && TRANSACTION_TYPES.has(o.transaction_type) ? o.transaction_type : undefined,
      showId: showId && whatnotRef("show", showId),
      currency: total?.currency,
      subtotalCents: sameCurrency(amounts.subtotal),
      shippingCents: sameCurrency(amounts.shipping),
      taxCents: sameCurrency(amounts.tax),
      discountCents: sameCurrency(obj(amounts.applied_discount).amount),
      totalCents: total?.cents,
      lineCount: items.length,
      linesComplete: lineProblems.length === 0,
    }),
    updatedAt ?? createdAt,
    receivedAt,
  );
  // A giveaway with nothing paid is no sale: sale.completed needs a payment above zero.
  if (!order.ok || !rawStatus || !SOLD.has(rawStatus) || !total || total.cents === 0) return [order];

  const sale = read(
    "sale",
    "sale.completed",
    { order: raw, items },
    lineProblems,
    `${id}`,
    { saleId: orderId, channel, lines, totalCents: total.cents, payments: [{ method: "other", amountCents: total.cents }] },
    createdAt ?? updatedAt,
    receivedAt,
  );
  if (!sale.ok || rawStatus !== "cancelled") return [order, sale];
  const returned = read(
    "return",
    "sale.returned",
    raw,
    [],
    `${id}`,
    { saleId: orderId, returnId: whatnotRef("return", id!), lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity, refundCents: l.unitPriceCents * l.quantity })), reason: "cancelled" },
    cancelledAt ?? updatedAt ?? createdAt,
    receivedAt,
  );
  return [order, sale, returned];
}

/**
 * A product as product.updated, with every page of its variants, and each
 * variant's available quantity as inventory.counted. A product, or a
 * variant's count, that doesn't read is dead-lettered.
 */
export function whatnotProductEvents(raw: unknown, variants: readonly unknown[], receivedAt: string): WhatnotRead[] {
  const p = obj(raw);
  const problems: string[] = [];
  if (p !== raw) problems.push("product is not an object");
  const id = whatnotId(p.id);
  if (!id) problems.push("product has no id that reads");
  const read_ = variants.map((v, i) => {
    const variant = obj(v);
    const variantId = whatnotId(variant.id);
    if (variant !== v || !variantId) problems.push(`variant ${i + 1} has no id that reads`);
    const quantity = obj(variant.inventory).available_quantity;
    return {
      raw: v,
      variantId: whatnotRef("variant", variantId ?? ""),
      sku: whatnotSku(variant.sku, variantId, id) ?? "",
      priceCents: whatnotMoney(variant.price)?.cents ?? null,
      inventoryQuantity: Number.isSafeInteger(quantity) && (quantity as number) >= 0 ? (quantity as number) : null,
    };
  });
  const at = whatnotTime(p.updated_at) ?? whatnotTime(p.created_at);
  const payload = {
    productId: whatnotRef("product", id ?? ""),
    title: text(p.title) ?? `Whatnot product ${id}`,
    // Whatnot's products have no status; a product that is listed is taken as active.
    status: "ACTIVE",
    vendor: null,
    productType: text(obj(p.category).name, 100) ?? null,
    tags: [],
    variants: read_.map(({ variantId, sku, priceCents, inventoryQuantity }) => ({ variantId, sku, priceCents, inventoryQuantity })),
  };
  const product = read("product", "product.updated", { product: raw, variants }, problems, `${id}:${digest(payload)}`, payload, at ?? receivedAt, receivedAt);
  if (!product.ok) return [product];
  return [
    product,
    ...read_.map((v) =>
      read(
        "count",
        "inventory.counted",
        v.raw,
        v.inventoryQuantity === null ? ["variant has no available quantity that reads"] : [],
        `${v.variantId.slice("whatnot:variant:".length)}:${v.inventoryQuantity}:${at ?? "unknown"}`,
        { sku: v.sku, onHand: v.inventoryQuantity, variantId: v.variantId },
        at ?? receivedAt,
        receivedAt,
      ),
    ),
  ];
}
