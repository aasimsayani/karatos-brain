/**
 * Turns eBay orders into Brain A events, in the same types and shapes as the
 * Shopify, BigCommerce and WooCommerce connectors, so an eBay sale reads like
 * any other:
 *
 * - order.updated: the order's latest state, with what eBay kept in fees;
 * - sale.completed once it is paid and not cancelled;
 * - sale.returned for each line refunded in full. A partial refund of a
 *   line's price (a goodwill amount, say) moves no stock, so it shows in the
 *   order's refundedCents only.
 *
 * Only what the departments use is kept. No buyer username, name, email
 * address, phone number, shipping address or checkout note, so no eBay user
 * data is stored at all.
 */

export type EbayRecord = Record<string, unknown>;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface EbayBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface EbayContext {
  receivedAt: string;
}

export interface EbayPage {
  orders: EbayRecord[];
  /** How many orders match the read in all, as eBay counts them. */
  total: number;
}

export class EbayShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EbayShapeError";
  }
}

/** Payment states at which the buyer has paid: refunds come after payment. */
export const EBAY_PAID_STATUSES = new Set(["PAID", "PARTIALLY_REFUNDED", "FULLY_REFUNDED"]);

export const ebayRef = (kind: string, id: string) => `ebay:${kind}:${id}`;

const ORDER_ID = /^[A-Za-z0-9-]{1,40}$/;
const NUMBER_ID = /^\d{1,20}$/;
const AMOUNT = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/;

const obj = (value: unknown): EbayRecord => (value && typeof value === "object" && !Array.isArray(value) ? (value as EbayRecord) : {});
const list = (value: unknown): EbayRecord[] => (Array.isArray(value) ? value.filter((v): v is EbayRecord => v !== null && typeof v === "object" && !Array.isArray(v)) : []);
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const id = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value) ? value : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A time eBay wrote, in UTC. Undefined when missing or unreadable, so the pipeline dead-letters the order. */
export function ebayTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** An eBay amount, { value: "125.50", currency }, in cents without floating point. Null for anything else. */
export function ebayCents(amount: unknown): number | null {
  const value = obj(amount).value;
  const match = typeof value === "string" ? AMOUNT.exec(value.trim()) : null;
  if (!match) return null;
  const decimals = (match[3] ?? "").padEnd(3, "0");
  const cents = Number(match[2]) * 100 + Number(decimals.slice(0, 2)) + (Number(decimals[2]) >= 5 ? 1 : 0);
  return match[1] && cents !== 0 ? -cents : cents;
}

/** An amount's currency code, or undefined. */
const currencyOf = (amount: unknown) => {
  const c = obj(amount).currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : undefined;
};

/** How the buyer paid, as the sales department names it. Payments eBay manages are by card, PayPal, Apple Pay or Google Pay. */
export function ebayPaymentMethod(method: unknown): string {
  if (method === "CREDIT_CARD" || method === "PAYPAL" || method === "EBAY") return "card";
  if (method === "CASH_ON_PICKUP") return "cash";
  return "other";
}

/** One page of getOrders. A body that isn't one throws, so a sync never skips orders unseen. */
export function ebayPage(body: unknown): EbayPage {
  const b = obj(body);
  // eBay leaves the list out when nothing matches.
  const orders = b.orders === undefined ? [] : b.orders;
  if (!Array.isArray(orders) || typeof b.total !== "number" || !Number.isSafeInteger(b.total) || b.total < 0) throw new EbayShapeError("eBay answered getOrders without an order list and total");
  return { orders: orders.map(obj), total: b.total };
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): EbayBrainEvent {
  return { id: `ebay_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `ebay:${key}`, payload };
}

/** A line's SKU: the seller's own, or a stable stand-in from the listing (and variation) it sold from. */
function lineSku(line: EbayRecord): string | undefined {
  const sku = text(line.sku, 100);
  if (sku) return sku;
  const item = id(line.legacyItemId, NUMBER_ID);
  const variation = id(line.legacyVariationId, NUMBER_ID);
  return item && `ebay-item-${item}${variation ? `-${variation}` : ""}`;
}

const quantityOf = (line: EbayRecord) => (typeof line.quantity === "number" && Number.isSafeInteger(line.quantity) ? line.quantity : null);

/** What a line sold for after discounts, in cents. */
function paidCents(line: EbayRecord): number | null {
  return ebayCents(line.discountedLineItemCost) ?? ebayCents(line.lineItemCost);
}

/** An order's events: its latest state, the sale once paid, and each line refunded in full. */
export function ebayOrderEvents(order: EbayRecord, ctx: EbayContext): EbayBrainEvent[] {
  const orderKey = id(order?.orderId, ORDER_ID);
  if (!orderKey) return [];
  const orderId = ebayRef("order", orderKey);
  const updatedAt = ebayTime(order.lastModifiedDate);
  const createdAt = ebayTime(order.creationDate);
  const pricing = obj(order.pricingSummary);
  const totalCents = ebayCents(pricing.total);
  const paymentStatus = text(order.orderPaymentStatus, 40);
  const cancelled = obj(order.cancelStatus).cancelState === "CANCELED";
  const lines = list(order.lineItems);
  const payments = obj(order.paymentSummary);
  const refunded = list(payments.refunds)
    .filter((r) => r.refundStatus === "REFUNDED")
    .reduce((sum, r) => sum + Math.max(ebayCents(r.amount) ?? 0, 0), 0);

  const events: EbayBrainEvent[] = [
    event(`order:${orderKey}:${updatedAt ?? "unknown"}`, "order.updated", updatedAt, ctx.receivedAt, defined({
      orderId,
      createdAt,
      status: text(order.orderFulfillmentStatus, 40) ?? null,
      paymentStatus: paymentStatus ?? null,
      cancelled,
      channel: "online",
      marketplace: "ebay",
      currency: currencyOf(pricing.total),
      totalCents,
      // What eBay kept: final value fees and the like, so a piece's margin on eBay can be compared with the store's.
      marketplaceFeeCents: ebayCents(order.totalMarketplaceFee) ?? undefined,
      refundedCents: refunded,
      lineCount: lines.length,
      // getOrders returns every line of an order in one record.
      linesComplete: true,
    })),
  ];

  const saleLines = lines.map((l) => {
    const quantity = quantityOf(l);
    const cost = ebayCents(l.lineItemCost);
    const paid = paidCents(l);
    return {
      sku: lineSku(l),
      quantity,
      // lineItemCost is the unit price times the quantity, before discounts.
      unitPriceCents: cost !== null && quantity ? Math.round(cost / quantity) : null,
      discountCents: cost !== null && paid !== null ? cost - paid : null,
    };
  });
  const readable = saleLines.every((l) => l.sku && l.quantity !== null && l.quantity > 0 && l.unitPriceCents !== null && l.unitPriceCents >= 0 && l.discountCents !== null && l.discountCents >= 0);
  // Keyed by order, not by update, so later changes never count the sale twice.
  if (paymentStatus && EBAY_PAID_STATUSES.has(paymentStatus) && !cancelled && totalCents !== null && totalCents > 0 && saleLines.length && readable) {
    const method = list(payments.payments)[0]?.paymentMethod;
    events.push(
      event(`sale:${orderKey}`, "sale.completed", createdAt, ctx.receivedAt, {
        saleId: orderId,
        channel: "online",
        lines: saleLines,
        totalCents,
        payments: [{ method: ebayPaymentMethod(method), amountCents: totalCents }],
      }),
    );
  }

  for (const line of lines) {
    const lineId = id(line.lineItemId, NUMBER_ID);
    const sku = lineSku(line);
    const quantity = quantityOf(line);
    const paid = paidCents(line);
    const refunds = list(line.refunds);
    if (!lineId || !sku || !quantity || quantity <= 0 || paid === null || paid <= 0) continue;
    const refundCents = refunds.reduce((sum, r) => sum + Math.max(ebayCents(r.amount) ?? 0, 0), 0);
    if (refundCents < paid) continue;
    const refundedAt = refunds.map((r) => ebayTime(r.refundDate)).filter((t): t is string => t !== undefined).sort().at(-1);
    events.push(
      event(`return:${orderKey}:${lineId}`, "sale.returned", refundedAt, ctx.receivedAt, {
        saleId: orderId,
        returnId: ebayRef("return", `${orderKey}:${lineId}`),
        lines: [{ sku, quantity, refundCents }],
      }),
    );
  }
  return events;
}

/** Every order of a page as events. */
export function ebayPageEvents(page: EbayPage, ctx: EbayContext): EbayBrainEvent[] {
  return page.orders.flatMap((order) => ebayOrderEvents(order, ctx));
}
