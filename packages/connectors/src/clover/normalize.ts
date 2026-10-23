import { createHash, createHmac } from "node:crypto";
import { CLOVER_ID } from "./client.js";

/**
 * Turns Clover records into Brain A events, in the shapes the Shopify, POS
 * and Stripe connectors already use for the same business:
 * - order.updated, as Shopify's, for each version of an order;
 * - sale.completed and sale.returned (sales department) for a paid order
 *   and each refund of its lines;
 * - payment.charge_updated and payment.refund_updated, as Stripe's, for
 *   payments and refunds;
 * - product.updated, as Shopify's, for items, and inventory.counted, as the
 *   POS connector's, for stock;
 * - customer.profile_updated (clienteling) for customers.
 *
 * Only the minimum is kept. A customer becomes a keyed reference
 * (HMAC-SHA256 under the instance's CUSTOMER_REF_KEY) with their marketing
 * choice: no names, email addresses, phone numbers or addresses. A card
 * payment keeps its card type and last four digits, nothing else of the card.
 * Order titles and notes, which staff type freely, are dropped.
 *
 * Clover writes times as epoch milliseconds and money as whole cents.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface CloverBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

type Rec = Record<string, unknown>;

export const CUSTOMER_REF_PREFIX = "clover_customer:";
const MIN_KEY_LENGTH = 32;

export class CloverCustomerKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloverCustomerKeyError";
  }
}

/** Throws unless the key is long enough to be a secret; generated keys are 64 hex characters. */
export function checkCustomerRefKey(key: string | undefined): string {
  const value = key?.trim() ?? "";
  if (value.length < MIN_KEY_LENGTH) throw new CloverCustomerKeyError(`CUSTOMER_REF_KEY must be at least ${MIN_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
  return value;
}

/** A Clover ID, or undefined for anything else. */
export const cloverId = (value: unknown): string | undefined => (typeof value === "string" && value.length === 13 && CLOVER_ID.test(value) ? value : undefined);

/** Epoch milliseconds to ISO 8601. Undefined for anything that isn't a plausible time, so the pipeline dead-letters the record. */
export function cloverTime(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isInteger(ms) && ms > 0 && ms < 1e14 ? new Date(ms).toISOString() : undefined;
}

/** Whole cents, or null for anything that isn't a whole number. */
export const cents = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);
const elements = (value: unknown): Rec[] => {
  const list = (value as { elements?: unknown } | null | undefined)?.elements;
  return Array.isArray(list) ? list.filter((e): e is Rec => !!e && typeof e === "object") : [];
};
/** Clover returns at most 100 elements of a nested list, without saying there are more. */
export const NESTED_LIMIT = 100;
const refId = (value: unknown) => cloverId((value as { id?: unknown } | null | undefined)?.id);

export const cloverRef = (kind: string, id: string) => `clover:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Rec): CloverBrainEvent {
  return { id: `clover_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `clover:${key}`, payload };
}

/** Clover tender label keys mapped to the sales department's payment methods. */
export function cloverPaymentMethod(labelKey: unknown, label?: unknown): string {
  const k = `${typeof labelKey === "string" ? labelKey.slice(0, 80) : ""} ${typeof label === "string" ? label.slice(0, 80) : ""}`.toLowerCase();
  if (k.includes("gift")) return "gift_card";
  if (k.includes("credit_card") || k.includes("debit_card") || k.includes("card")) return "card";
  if (k.includes("cash")) return "cash";
  if (k.includes("check") || k.includes("cheque")) return "check";
  if (k.includes("financ") || k.includes("affirm") || k.includes("klarna") || k.includes("synchrony")) return "financing";
  return "other";
}

/** Card types Clover names; anything else is "other", so free text never lands here. */
const CARD_TYPES = new Set(["VISA", "MC", "AMEX", "DISCOVER", "DINERS_CLUB", "JCB", "MAESTRO", "SOLO", "LASER", "CHINA_UNION_PAY", "CARTE_BLANCHE", "UNKNOWN", "GIFT_CARD", "EBT", "GIROCARD", "INTERAC", "OTHER"]);

/** At most the card type and last four digits. Never the first six, the name, the token or anything else. */
export function cardSummary(card: unknown): { cardType: string; last4: string | null } | null {
  if (!card || typeof card !== "object") return null;
  const c = card as Rec;
  const type = typeof c.cardType === "string" && CARD_TYPES.has(c.cardType) ? c.cardType : "OTHER";
  const last4 = typeof c.last4 === "string" && /^\d{4}$/.test(c.last4) ? c.last4 : null;
  return { cardType: type, last4 };
}

/** Item ID to SKU, as known from the items the sync has read. */
export type SkuLookup = (itemId: string) => string | undefined;

/** An item's SKU, or a stable stand-in for items without one; the same everywhere the item appears. */
export function itemSku(item: Rec): string | undefined {
  const id = cloverId(item.id);
  if (!id) return undefined;
  const sku = text(item.sku, 100);
  return sku ? sku : `clover-item-${id}`;
}

function lineSku(line: Rec, skus: SkuLookup): string {
  const itemId = refId(line.item);
  if (itemId) return skus(itemId) ?? `clover-item-${itemId}`;
  // A custom amount rung up without an item.
  return `clover-line-${cloverId(line.id) ?? "unknown"}`;
}

/**
 * One line's quantity and price. Clover rings each piece as its own line;
 * an item sold by quantity or weight carries unitQty in thousandths with
 * the price per unit. A fractional quantity becomes one line at its total.
 */
function linePrice(line: Rec): { quantity: number; unitPriceCents: number | null; totalCents: number | null } {
  const price = cents(line.price);
  const unitQty = line.unitQty;
  if (typeof unitQty === "number" && Number.isInteger(unitQty) && unitQty > 0 && price !== null) {
    if (unitQty % 1000 === 0) return { quantity: unitQty / 1000, unitPriceCents: price, totalCents: (price * unitQty) / 1000 };
    const total = Math.round((price * unitQty) / 1000);
    return { quantity: 1, unitPriceCents: total, totalCents: total };
  }
  return { quantity: 1, unitPriceCents: price, totalCents: price };
}

/** A line's own discounts in cents: fixed amounts (Clover writes them negative) and percentages of the line. */
function lineDiscount(line: Rec, lineTotal: number | null): number {
  let total = 0;
  for (const d of elements(line.discounts)) {
    if (typeof d.amount === "number" && Number.isInteger(d.amount)) total += Math.abs(d.amount);
    else if (typeof d.percentage === "number" && Number.isFinite(d.percentage) && lineTotal !== null) total += Math.round((lineTotal * Math.abs(d.percentage)) / 100);
  }
  return total;
}

/** Payment states at which the money has been taken. */
const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);
const PAYMENT_OK = new Set(["SUCCESS", "AUTH_COMPLETED"]);

export interface CloverNormalizeOptions {
  merchantId: string;
  /** This instance's CUSTOMER_REF_KEY, at least 32 characters. */
  customerKey: string;
}

export function cloverNormalizer(options: CloverNormalizeOptions) {
  const key = checkCustomerRefKey(options.customerKey);
  const merchantId = options.merchantId;

  /** The keyed reference for a Clover customer. The merchant is signed in, so two merchants never share one. */
  function customerRef(id: string): string {
    const mac = createHmac("sha256", key).update(`clover:customer:v1:${merchantId}:${id}`, "utf8").digest("hex");
    return `${CUSTOMER_REF_PREFIX}${mac.slice(0, 32)}`;
  }

  function orderEvents(order: Rec, receivedAt: string, skus: SkuLookup): CloverBrainEvent[] {
    const id = cloverId(order.id);
    if (!id) return [];
    const modified = cloverTime(order.modifiedTime);
    const totalCents = cents(order.total);
    const lineRecords = elements(order.lineItems);
    const linesComplete = lineRecords.length < NESTED_LIMIT;
    const customer = refId(elements(order.customers)[0]);
    const customerId = customer ? customerRef(customer) : undefined;
    const paymentState = text(order.paymentState, 40) ?? null;
    const currency = text(order.currency, 3) ?? null;
    const events: CloverBrainEvent[] = [
      event(`order:${id}:${typeof order.modifiedTime === "number" ? order.modifiedTime : "unknown"}`, "order.updated", modified, receivedAt, {
        orderId: cloverRef("order", id),
        createdAt: cloverTime(order.createdTime) ?? null,
        financialStatus: paymentState,
        state: text(order.state, 40) ?? null,
        channel: "store",
        currency,
        totalCents,
        lineCount: lineRecords.length,
        linesComplete,
        ...(customerId ? { customerId } : {}),
      }),
    ];

    const lines = lineRecords.map((line) => {
      const { quantity, unitPriceCents, totalCents: lineTotal } = linePrice(line);
      return { id: cloverId(line.id), sku: lineSku(line, skus), quantity, unitPriceCents, lineTotal, discountCents: lineDiscount(line, lineTotal) };
    });
    const priced = lines.every((l) => l.unitPriceCents !== null && l.unitPriceCents >= 0);
    const payments = elements(order.payments)
      .filter((p) => typeof p.result !== "string" || PAYMENT_OK.has(p.result))
      .flatMap((p) => {
        const amount = cents(p.amount);
        const tender = (p.tender ?? {}) as Rec;
        return amount !== null && amount > 0 ? [{ method: cloverPaymentMethod(tender.labelKey, tender.label), amountCents: amount }] : [];
      });
    // Keyed by order, not by version, so later edits never count the sale twice.
    if (PAID.has(paymentState ?? "") && totalCents !== null && totalCents > 0 && lines.length && linesComplete && priced) {
      events.push(
        event(`sale:${id}`, "sale.completed", cloverTime(order.clientCreatedTime) ?? cloverTime(order.createdTime), receivedAt, {
          saleId: cloverRef("order", id),
          ...(customerId ? { customerId } : {}),
          channel: "store",
          lines: lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unitPriceCents: l.unitPriceCents, discountCents: l.discountCents })),
          totalCents,
          payments: payments.length ? payments : [{ method: "other", amountCents: totalCents }],
        }),
      );
    }

    const byId = new Map(lines.filter((l) => l.id).map((l) => [l.id!, l]));
    for (const refund of elements(order.refunds)) {
      const refundId = cloverId(refund.id);
      if (!refundId || refund.voided === true || (typeof refund.status === "string" && refund.status !== "SUCCESS")) continue;
      const returned = elements(refund.lineItems).flatMap((r) => {
        const line = byId.get(cloverId(r.id) ?? "");
        return line ? [{ sku: line.sku, quantity: line.quantity, refundCents: Math.max(0, (line.lineTotal ?? 0) - line.discountCents) }] : [];
      });
      // A refund of an amount rather than of lines has nothing to return; payment.refund_updated records the money.
      if (!returned.length) continue;
      events.push(
        event(`refund:${refundId}`, "sale.returned", cloverTime(refund.createdTime), receivedAt, {
          saleId: cloverRef("order", id),
          returnId: cloverRef("refund", refundId),
          lines: returned,
        }),
      );
    }
    return events;
  }

  /** A payment's state; the key moves with modifiedTime, so each version is stored once. */
  function paymentEvents(payment: Rec, receivedAt: string): CloverBrainEvent[] {
    const id = cloverId(payment.id);
    if (!id) return [];
    const result = text(payment.result, 40) ?? "UNKNOWN";
    const tender = (payment.tender ?? {}) as Rec;
    const card = cardSummary(payment.cardTransaction);
    const order = refId(payment.order);
    const refunded = elements(payment.refunds).reduce((sum, r) => sum + (cents(r.amount) ?? 0), 0);
    return [
      event(`payment:${id}:${typeof payment.modifiedTime === "number" ? payment.modifiedTime : "unknown"}`, "payment.charge_updated", cloverTime(payment.modifiedTime) ?? cloverTime(payment.createdTime), receivedAt, {
        chargeId: cloverRef("payment", id),
        status: result.toLowerCase(),
        paid: PAYMENT_OK.has(result),
        captured: result === "SUCCESS" || result === "AUTH_COMPLETED",
        amountCents: cents(payment.amount),
        tipCents: cents(payment.tipAmount) ?? 0,
        taxCents: cents(payment.taxAmount) ?? 0,
        refundedCents: refunded,
        currency: text((payment.cardTransaction as Rec | undefined)?.currency, 3) ?? null,
        disputed: false,
        method: cloverPaymentMethod(tender.labelKey, tender.label),
        cardBrand: card?.cardType ?? null,
        cardLast4: card?.last4 ?? null,
        offline: payment.offline === true,
        ...(order ? { orderId: cloverRef("order", order) } : {}),
      }),
    ];
  }

  function refundEvents(refund: Rec, receivedAt: string): CloverBrainEvent[] {
    const id = cloverId(refund.id);
    if (!id) return [];
    const status = refund.voided === true ? "voided" : (text(refund.status, 20) ?? "SUCCESS").toLowerCase();
    const payment = refId(refund.payment);
    const order = refId(refund.orderRef);
    return [
      event(`refund_payment:${id}:${status}`, "payment.refund_updated", cloverTime(refund.createdTime), receivedAt, {
        refundId: cloverRef("refund", id),
        ...(payment ? { chargeId: cloverRef("payment", payment) } : {}),
        ...(order ? { orderId: cloverRef("order", order) } : {}),
        amountCents: cents(refund.amount),
        taxCents: cents(refund.taxAmount) ?? 0,
        tipCents: cents(refund.tipAmount) ?? 0,
        currency: null,
        status,
        reason: null,
      }),
    ];
  }

  /** An item's version, in Shopify's product.updated shape with one variant: Clover items are sold as they are. */
  function itemEvents(item: Rec, receivedAt: string): CloverBrainEvent[] {
    const id = cloverId(item.id);
    if (!id) return [];
    const status = item.deleted === true ? "DELETED" : item.hidden === true ? "HIDDEN" : "ACTIVE";
    const stock = (item.itemStock ?? null) as Rec | null;
    return [
      event(`item:${id}:${typeof item.modifiedTime === "number" ? item.modifiedTime : "unknown"}`, "product.updated", cloverTime(item.modifiedTime), receivedAt, {
        productId: cloverRef("item", id),
        title: text(item.name) || `Clover item ${id}`,
        status,
        vendor: null,
        productType: null,
        tags: [],
        costCents: cents(item.cost),
        variants: [
          {
            variantId: cloverRef("item", id),
            sku: itemSku(item)!,
            priceCents: cents(item.price),
            inventoryQuantity: typeof stock?.quantity === "number" && Number.isInteger(stock.quantity) ? stock.quantity : null,
          },
        ],
      }),
    ];
  }

  /**
   * What an item's stock stood at when the sync read it, as the POS
   * connector's inventory.counted. Item stocks carry no time of their own, so
   * the key holds the day read and the count: the same count read again that
   * day is a duplicate, and a change is a new count. A negative or fractional
   * count is kept as read and the department schema dead-letters it.
   */
  function stockEvents(stock: Rec, receivedAt: string, skus: SkuLookup): CloverBrainEvent[] {
    const itemId = refId(stock.item);
    if (!itemId) return [];
    const quantity = typeof stock.quantity === "number" ? stock.quantity : typeof stock.stockCount === "number" ? stock.stockCount : null;
    const day = receivedAt.slice(0, 10);
    return [
      event(`count:${itemId}:${day}:${quantity ?? "unknown"}`, "inventory.counted", cloverTime(stock.modifiedTime) ?? receivedAt, receivedAt, {
        sku: skus(itemId) ?? `clover-item-${itemId}`,
        onHand: quantity,
      }),
    ];
  }

  /**
   * A customer as a keyed reference and their marketing choice. Clover
   * customers have no modified time, so the key holds a short hash of what is
   * kept: a changed choice is a new event, the same record again a duplicate.
   */
  function customerEvents(customer: Rec, receivedAt: string): CloverBrainEvent[] {
    const id = cloverId(customer.id);
    if (!id) return [];
    const ref = customerRef(id);
    const marketingConsent = customer.marketingAllowed === true;
    const version = createHash("sha256").update(`${ref}|${marketingConsent}`).digest("hex").slice(0, 12);
    return [
      event(`customer:${ref.slice(CUSTOMER_REF_PREFIX.length)}:${version}`, "customer.profile_updated", receivedAt, receivedAt, {
        customerId: ref,
        // The clienteling schema needs a name; the customer's own is never kept.
        name: "Clover customer",
        marketingConsent,
      }),
    ];
  }

  return { customerRef, orderEvents, paymentEvents, refundEvents, itemEvents, stockEvents, customerEvents };
}

export type CloverNormalizer = ReturnType<typeof cloverNormalizer>;
