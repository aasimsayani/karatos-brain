import { createHash } from "node:crypto";
import { ETSY_EPOCH_MIN, ETSY_ID, type EtsyRecord } from "./client.js";

/**
 * Etsy receipts and listings as Brain A events, in the types and shapes the
 * eBay and Shopify connectors give, so an Etsy sale reads like any other:
 *
 * - order.updated: a receipt's latest state, for each change;
 * - sale.completed once it is paid and not cancelled, keyed by receipt so
 *   a later change never counts it twice;
 * - sale.returned once it is fully refunded. A partial refund moves no
 *   stock, so it shows in the order's refundedCents only;
 * - product.updated for each listing with its products as variants;
 * - inventory.counted for each product's stock on Etsy.
 *
 * Only what the departments use is kept: no buyer id, name, email address,
 * shipping address, gift or checkout message, no seller email, no tracking
 * code, and no listing descriptions, tags or materials.
 */

export interface EtsyBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface EtsyContext {
  receivedAt: string;
  shopId: string;
}

export const etsyRef = (kind: string, id: string) => `etsy:${kind}:${id}`;

const obj = (value: unknown): EtsyRecord => (value && typeof value === "object" && !Array.isArray(value) ? (value as EtsyRecord) : {});
const list = (value: unknown): EtsyRecord[] => (Array.isArray(value) ? value.filter((v): v is EtsyRecord => v !== null && typeof v === "object" && !Array.isArray(v)) : []);
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): EtsyBrainEvent {
  return { id: `etsy_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `etsy:${key}`, payload };
}

/** Etsy's id for a record, as a string, or undefined for anything else. */
export function etsyId(value: unknown): string | undefined {
  const s = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof s === "string" && ETSY_ID.test(s) ? s : undefined;
}

/** Epoch seconds as an ISO time; undefined unless it is a whole number from 2000 up to 2286. */
export function etsyTime(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && (value as number) >= ETSY_EPOCH_MIN && (value as number) < 1e10 ? new Date((value as number) * 1000).toISOString() : undefined;
}

/** An Etsy money object, { amount, divisor, currency_code }, in cents; null for anything else. */
export function etsyCents(money: unknown): number | null {
  const m = obj(money);
  const { amount, divisor } = m;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(divisor) || (divisor as number) < 1) return null;
  const cents = Math.round(((amount as number) * 100) / (divisor as number));
  return Number.isSafeInteger(cents) ? cents : null;
}

const currencyOf = (money: unknown) => {
  const c = obj(money).currency_code;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : undefined;
};

/** How the buyer paid, as the sales department names it. */
export function etsyPaymentMethod(method: unknown): string {
  if (method === "cc" || method === "paypal" || method === "apple_pay" || method === "google_pay" || method === "klarna" || method === "ideal" || method === "sofort") return "card";
  if (method === "check") return "check";
  if (method === "bt") return "wire";
  return "other";
}

/** A line's SKU: the seller's own, or a stable stand-in from the listing and product it sold from. */
export function etsySku(sku: unknown, listingId: unknown, productId: unknown): string | undefined {
  const own = text(sku, 100);
  if (own) return own;
  const listing = etsyId(listingId);
  const product = etsyId(productId);
  return listing && `etsy-listing-${listing}${product ? `-${product}` : ""}`;
}

const STATUSES = new Set(["paid", "completed", "open", "payment processing", "canceled", "fully refunded", "partially refunded"]);

/** A receipt's events: its latest state, the sale once paid, and the return once refunded in full. */
export function etsyReceiptEvents(receipt: EtsyRecord, ctx: EtsyContext): EtsyBrainEvent[] {
  const id = etsyId(receipt?.receipt_id);
  if (!id) return [];
  const orderId = etsyRef("receipt", id);
  const createdAt = etsyTime(receipt.created_timestamp ?? receipt.create_timestamp);
  const updatedAt = etsyTime(receipt.updated_timestamp ?? receipt.update_timestamp);
  const rawStatus = typeof receipt.status === "string" ? receipt.status.trim().toLowerCase() : "";
  const status = STATUSES.has(rawStatus) ? rawStatus.replace(/ /g, "_").toUpperCase() : null;
  const cancelled = status === "CANCELED";
  const paid = receipt.is_paid === true;
  const totalCents = etsyCents(receipt.grandtotal);
  const refunds = list(receipt.refunds);
  const refundedCents = refunds.reduce((sum, r) => sum + Math.max(etsyCents(r.amount) ?? 0, 0), 0);
  const lines = list(receipt.transactions);

  const events: EtsyBrainEvent[] = [
    event(`order:${id}:${updatedAt ?? "unknown"}`, "order.updated", updatedAt, ctx.receivedAt, defined({
      orderId,
      locationId: etsyRef("shop", ctx.shopId),
      createdAt,
      status,
      paid,
      shipped: receipt.is_shipped === true,
      cancelled,
      channel: "online",
      marketplace: "etsy",
      currency: currencyOf(receipt.grandtotal),
      totalCents,
      refundedCents,
      lineCount: lines.length,
      // A receipt carries every one of its transactions.
      linesComplete: true,
    })),
  ];

  const saleLines = lines.map((l) => {
    const quantity = Number.isSafeInteger(l.quantity) ? (l.quantity as number) : null;
    const shopCoupon = typeof l.shop_coupon === "number" && Number.isFinite(l.shop_coupon) ? Math.round(l.shop_coupon * 100) : 0;
    return {
      sku: etsySku(l.sku, l.listing_id, l.product_id),
      quantity,
      // A transaction's price is per item.
      unitPriceCents: etsyCents(l.price),
      discountCents: shopCoupon,
    };
  });
  const readable = saleLines.every((l) => l.sku && l.quantity !== null && l.quantity > 0 && l.unitPriceCents !== null && l.unitPriceCents >= 0 && l.discountCents >= 0);
  if (paid && !cancelled && totalCents !== null && totalCents > 0 && saleLines.length && readable) {
    events.push(
      event(`sale:${id}`, "sale.completed", createdAt, ctx.receivedAt, {
        saleId: orderId,
        channel: "online",
        lines: saleLines,
        totalCents,
        payments: [{ method: etsyPaymentMethod(receipt.payment_method), amountCents: totalCents }],
      }),
    );
  }

  if (status === "FULLY_REFUNDED" && saleLines.length && readable) {
    const refundedAt = refunds.map((r) => etsyTime(r.created_timestamp)).filter((t): t is string => t !== undefined).sort().at(-1) ?? updatedAt;
    events.push(
      event(`return:${id}`, "sale.returned", refundedAt, ctx.receivedAt, {
        saleId: orderId,
        returnId: etsyRef("return", id),
        lines: saleLines.map((l) => ({ sku: l.sku, quantity: l.quantity, refundCents: l.unitPriceCents! * l.quantity! - l.discountCents })),
      }),
    );
  }
  return events;
}

const LISTING_STATUS: Record<string, string> = { active: "ACTIVE", sold_out: "ACTIVE", draft: "DRAFT", inactive: "ARCHIVED", expired: "ARCHIVED" };

interface Variant {
  variantId: string;
  sku: string;
  priceCents: number | null;
  inventoryQuantity: number | null;
}

/** A listing's products that aren't deleted, with the price and stock of their enabled offerings. */
function variantsOf(listing: EtsyRecord, listingId: string): Variant[] {
  return list(obj(listing.inventory).products).flatMap((p) => {
    const productId = etsyId(p.product_id);
    if (!productId || p.is_deleted === true) return [];
    const offerings = list(p.offerings).filter((o) => o.is_deleted !== true && o.is_enabled !== false);
    const quantities = offerings.map((o) => o.quantity);
    return [{
      variantId: etsyRef("product", productId),
      sku: etsySku(p.sku, listingId, productId)!,
      priceCents: offerings.length ? etsyCents(offerings[0]!.price) : null,
      // A quantity Etsy gave that isn't a whole number from 0 stays unreadable, so the inventory schema dead-letters it.
      inventoryQuantity: quantities.every((q) => Number.isSafeInteger(q) && (q as number) >= 0) ? quantities.reduce((sum: number, q) => sum + (q as number), 0) : null,
    }];
  });
}

/** A listing as product.updated, and each of its products' stock as inventory.counted. */
export function etsyListingEvents(listing: EtsyRecord, ctx: EtsyContext): EtsyBrainEvent[] {
  const id = etsyId(listing?.listing_id);
  if (!id) return [];
  const updatedAt = etsyTime(listing.updated_timestamp ?? listing.last_modified_timestamp);
  const state = typeof listing.state === "string" ? listing.state : "";
  const variants = variantsOf(listing, id);
  const payload = {
    productId: etsyRef("listing", id),
    title: text(listing.title) ?? `Etsy listing ${id}`,
    status: LISTING_STATUS[state] ?? "ARCHIVED",
    vendor: null,
    productType: null,
    tags: [],
    variants,
  };
  const at = updatedAt ?? ctx.receivedAt;
  return [
    event(`product:${id}:${digest(payload)}`, "product.updated", at, ctx.receivedAt, payload),
    ...variants.map((v) =>
      event(`count:${v.variantId.slice(13)}:${v.inventoryQuantity ?? "unknown"}:${at}`, "inventory.counted", at, ctx.receivedAt, {
        sku: v.sku,
        onHand: v.inventoryQuantity,
        variantId: v.variantId,
        locationId: etsyRef("shop", ctx.shopId),
      }),
    ),
  ];
}
