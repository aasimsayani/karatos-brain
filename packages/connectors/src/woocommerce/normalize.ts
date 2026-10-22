import { createHash } from "node:crypto";

/**
 * Turns WooCommerce records into Brain A events, in the same types and
 * shapes as the Shopify, Square, Clover, POS and Stripe connectors, so a
 * WooCommerce sale reads like any other:
 *
 * - orders: order.updated (Shopify's shape), sale.completed once paid (the
 *   sales department's schema) and payment.charge_updated for the order's
 *   payment (Stripe's shape);
 * - refunds: payment.refund_updated (Stripe's shape), and sale.returned when
 *   the refund returns lines;
 * - products with their variations: product.updated (Shopify's shape), and
 *   inventory.counted (the POS connector's shape) for each product or
 *   variation whose stock WooCommerce manages;
 * - customers: customer.profile_updated, under a keyed reference.
 *
 * Only what the departments use is kept. No names, email addresses, phone
 * numbers, billing or shipping addresses, customer notes, IP addresses,
 * user agents, transaction IDs, refund reasons or meta data.
 */

export type WooRecord = Record<string, unknown>;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface WooCommerceBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** What normalizing needs from the connector: keyed customer references. */
export interface WooCommerceContext {
  receivedAt: string;
  customerRef(id: unknown): string | undefined;
}

/** WooCommerce's numeric IDs. Undefined for 0 (a guest, or no product) and anything else. */
export function wooId(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * A `_gmt` time WooCommerce wrote (it has no zone suffix), as ISO 8601 UTC.
 * Undefined when missing or unreadable, so the pipeline dead-letters the record.
 */
export function wooTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  const match = TIME.exec(value);
  if (!match) return undefined;
  const ms = Date.parse(`${match[1]}${match[2] ?? ""}${match[3] ?? "Z"}`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** "125.50" → 12550, without floating point, rounding past the cent. Null for anything that isn't a plain amount. */
export function wooCents(amount: unknown): number | null {
  if (typeof amount === "number") amount = Number.isFinite(amount) ? amount.toFixed(4) : "";
  if (typeof amount !== "string" || amount.length > 24) return null;
  const match = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) return null;
  const fraction = (match[3] ?? "").padEnd(3, "0");
  let cents = Number(match[2]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  return match[1] && cents !== 0 ? -cents : cents;
}

/** A whole item count. Null for fractions and anything unreadable. */
export function wooQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
/** WooCommerce's slugs: order statuses, product types and statuses, payment method IDs. */
const slug = (value: unknown, max = 40) => (typeof value === "string" && value.length <= max && /^[a-z0-9][a-z0-9_-]*$/.test(value) ? value : undefined);
const list = (value: unknown): WooRecord[] => (Array.isArray(value) ? value.filter((v): v is WooRecord => v !== null && typeof v === "object" && !Array.isArray(v)) : []);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const currencyOf = (value: unknown) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined);

export const wooRef = (kind: string, id: number) => `woocommerce:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): WooCommerceBrainEvent {
  // A record missing its timestamp gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `woocommerce_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `woocommerce:${key}`, payload };
}

/** WooCommerce payment method IDs (the gateway's slug) mapped to the sales department's payment methods. */
export function wooPaymentMethod(method: unknown): string {
  const m = slug(method, 60) ?? "";
  if (m === "cod") return "cash";
  if (m === "cheque") return "check";
  if (m === "bacs") return "wire";
  if (m.includes("gift")) return "gift_card";
  if (/affirm|klarna|afterpay|clearpay|sezzle|zip|synchrony|acima|financ/.test(m)) return "financing";
  if (/stripe|woocommerce_payments|wcpay|paypal|ppcp|square|braintree|authorize|card|cybersource|worldpay|clover|elavon|moneris|payfast|mollie/.test(m)) return "card";
  return "other";
}

/** Order statuses at which the money has been taken, when the order also has a paid date. A completed order counts as paid either way. */
const PAID = new Set(["processing", "completed", "refunded"]);

/** A line's SKU, or a stable stand-in for products sold without one, as Shopify's connector uses shopify-variant-<id>. */
function lineSku(orderId: number, line: WooRecord): string {
  const sku = text(line.sku, 100);
  if (sku) return sku;
  const variation = wooId(line.variation_id);
  if (variation) return `woocommerce-variation-${variation}`;
  const product = wooId(line.product_id);
  if (product) return `woocommerce-product-${product}`;
  return `woocommerce-line-${orderId}-${wooId(line.id) ?? 0}`;
}

/** Where an order was sold: WooCommerce's point of sale counts as the store, everything else as online. */
function channelOf(order: WooRecord): "store" | "online" {
  return /pos/.test(slug(order.created_via, 60) ?? "") ? "store" : "online";
}

/** An order's events: its latest state, the sale once paid, and its payment. */
export function wooOrderEvents(order: WooRecord, ctx: WooCommerceContext): WooCommerceBrainEvent[] {
  const id = wooId(order?.id);
  if (!id) return [];
  const modifiedRaw = typeof order.date_modified_gmt === "string" ? order.date_modified_gmt.slice(0, 40) : "unknown";
  const modified = wooTime(order.date_modified_gmt);
  const status = slug(order.status);
  const totalCents = wooCents(order.total);
  const currency = currencyOf(order.currency);
  const channel = channelOf(order);
  const customerId = ctx.customerRef(order.customer_id);
  const paidAt = wooTime(order.date_paid_gmt);
  const lines = list(order.line_items);
  const events: WooCommerceBrainEvent[] = [
    event(`order:${id}:${modifiedRaw}`, "order.updated", modified, ctx.receivedAt, defined({
      orderId: wooRef("order", id),
      createdAt: wooTime(order.date_created_gmt) ?? null,
      status: status ?? null,
      paidAt: paidAt ?? null,
      completedAt: wooTime(order.date_completed_gmt) ?? null,
      cancelledAt: status === "cancelled" ? modified ?? null : null,
      channel,
      currency: currency ?? null,
      totalCents,
      lineCount: lines.length,
      // WooCommerce returns every line of an order.
      linesComplete: true,
      customerId,
    })),
  ];

  const saleLines = lines.map((l) => {
    const quantity = wooQuantity(l.quantity);
    const subtotal = wooCents(l.subtotal);
    const total = wooCents(l.total);
    const unitPriceCents = quantity && quantity > 0 && subtotal !== null ? Math.round(subtotal / quantity) : null;
    return { sku: lineSku(id, l), quantity, unitPriceCents, discountCents: subtotal !== null && total !== null ? Math.max(0, subtotal - total) : 0 };
  });
  const readable = saleLines.every((l) => l.quantity !== null && l.quantity > 0 && l.unitPriceCents !== null && l.unitPriceCents >= 0);
  const paid = status === "completed" || (PAID.has(status ?? "") && paidAt !== undefined);
  // Keyed by order, not by update, so later edits never count the sale twice.
  if (paid && totalCents !== null && totalCents > 0 && saleLines.length && readable) {
    events.push(
      event(`sale:${id}`, "sale.completed", paidAt ?? wooTime(order.date_completed_gmt) ?? wooTime(order.date_created_gmt), ctx.receivedAt, defined({
        saleId: wooRef("order", id),
        customerId,
        channel,
        lines: saleLines,
        totalCents,
        payments: [{ method: wooPaymentMethod(order.payment_method), amountCents: totalCents }],
      })),
    );
  }

  if (paidAt) {
    // WooCommerce has no payment records of its own; the order's paid date, total and refunds stand in for one.
    const refundedCents = list(order.refunds).reduce((sum, r) => sum + Math.abs(wooCents(r.total) ?? 0), 0);
    events.push(
      event(`payment:${id}:${status ?? "unknown"}:${refundedCents}`, "payment.charge_updated", paidAt, ctx.receivedAt, defined({
        chargeId: wooRef("payment", id),
        status: status ?? null,
        paid: true,
        captured: true,
        amountCents: totalCents,
        capturedCents: totalCents,
        refundedCents,
        currency: currency?.toLowerCase(),
        method: wooPaymentMethod(order.payment_method),
        // WooCommerce's order holds no card details, and the gateway's transaction ID isn't kept.
        cardBrand: null,
        orderId: wooRef("order", id),
        customerId,
      })),
    );
  }
  return events;
}

/** A refund, from the store-wide refunds list: its money in Stripe's shape, and the lines it returned. Refunds never change once made. */
export function wooRefundEvents(refund: WooRecord, ctx: WooCommerceContext): WooCommerceBrainEvent[] {
  const id = wooId(refund?.id);
  const order = wooId(refund?.parent_id);
  if (!id || !order) return [];
  const created = wooTime(refund.date_created_gmt);
  const events: WooCommerceBrainEvent[] = [
    event(`refund:${id}`, "payment.refund_updated", created, ctx.receivedAt, {
      refundId: wooRef("refund", id),
      chargeId: wooRef("payment", order),
      orderId: wooRef("order", order),
      amountCents: wooCents(refund.amount),
      // A refund is recorded once made; refundedPayment says whether the gateway sent the money back or it was refunded by hand.
      status: "succeeded",
      refundedPayment: refund.refunded_payment === true,
      // The reason is free text staff type, so it isn't kept.
      reason: null,
    }),
  ];
  // Refund lines carry negative quantities and totals.
  const returned = list(refund.line_items)
    .map((l) => {
      const quantity = wooQuantity(l.quantity);
      const total = wooCents(l.total);
      return { sku: lineSku(order, l), quantity: quantity === null ? null : Math.abs(quantity), refundCents: total === null ? null : Math.abs(total) };
    })
    .filter((l) => l.quantity !== 0);
  // A refund of an amount only (shipping, goodwill) has no lines; its money event records it.
  if (returned.length) {
    events.push(
      event(`return:${id}`, "sale.returned", created, ctx.receivedAt, {
        saleId: wooRef("order", order),
        returnId: wooRef("refund", id),
        lines: returned,
      }),
    );
  }
  return events;
}

interface Unit {
  kind: "product" | "variation";
  id: number;
  record: WooRecord;
}

const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * A product with its variations: product.updated in Shopify's shape, and a
 * stock count for each product or variation whose stock WooCommerce
 * manages. `variations` is null for a product that has none to read (any
 * type but variable).
 */
export function wooProductEvents(product: WooRecord, variations: WooRecord[] | null, ctx: WooCommerceContext): WooCommerceBrainEvent[] {
  const id = wooId(product?.id);
  if (!id) return [];
  const modifiedRaw = typeof product.date_modified_gmt === "string" ? product.date_modified_gmt.slice(0, 40) : "unknown";
  const modified = wooTime(product.date_modified_gmt);
  const units: Unit[] = variations
    ? variations.flatMap((v) => (wooId(v.id) ? [{ kind: "variation" as const, id: wooId(v.id)!, record: v }] : []))
    : [{ kind: "product", id, record: product }];
  const managed = (u: Unit) => u.record.manage_stock === true;
  const variants = units.map((u) => ({
    variantId: wooRef(u.kind, u.id),
    sku: text(u.record.sku, 100) ?? `woocommerce-${u.kind}-${u.id}`,
    priceCents: wooCents(u.record.price),
    // A variation that leaves stock to its product says manage_stock "parent"; the product's count covers it.
    inventoryQuantity: managed(u) ? wooQuantity(u.record.stock_quantity) : null,
  }));
  const payload = {
    productId: wooRef("product", id),
    title: text(product.name) ?? `WooCommerce product ${id}`,
    status: slug(product.status) ?? null,
    vendor: null,
    productType: slug(product.type) ?? null,
    tags: list(product.tags).flatMap((t) => text(t.name, 60) ?? []).slice(0, 20),
    variants,
  };
  // A variation can change without its product's modified date moving, so the variants are part of the key.
  const events: WooCommerceBrainEvent[] = [event(`product:${id}:${modifiedRaw}:${short(JSON.stringify(variants))}`, "product.updated", modified, ctx.receivedAt, payload)];

  const counted: Unit[] = variations && product.manage_stock === true ? [{ kind: "product", id, record: product }, ...units] : units;
  for (const u of counted.filter(managed)) {
    const at = wooTime(u.record.date_modified_gmt) ?? modified;
    const onHand = wooQuantity(u.record.stock_quantity);
    events.push(
      event(`count:${u.kind}:${u.id}:${at ?? "unknown"}:${onHand ?? "unknown"}`, "inventory.counted", at, ctx.receivedAt, {
        sku: text(u.record.sku, 100) ?? `woocommerce-${u.kind}-${u.id}`,
        // A negative count (backorders) or a missing one is kept as WooCommerce reports it, so the inventory schema dead-letters it.
        onHand,
        variantId: wooRef(u.kind, u.id),
        productId: wooRef("product", id),
      }),
    );
  }
  return events;
}

/**
 * A customer profile under its keyed reference. The name the departments
 * see is a label made from the reference, never the customer's own.
 * WooCommerce keeps no marketing consent of its own, so consent is never
 * assumed.
 */
export function wooCustomerEvent(customer: WooRecord, ctx: WooCommerceContext): WooCommerceBrainEvent | null {
  const ref = ctx.customerRef(customer?.id);
  if (!ref) return null;
  const at = wooTime(customer.date_modified_gmt) ?? wooTime(customer.date_created_gmt);
  const mac = ref.slice(ref.lastIndexOf(":") + 1);
  return event(`customer:${mac}:${at ?? "unknown"}`, "customer.profile_updated", at, ctx.receivedAt, {
    customerId: ref,
    name: `WooCommerce customer ${mac.slice(0, 8)}`,
    marketingConsent: false,
  });
}
