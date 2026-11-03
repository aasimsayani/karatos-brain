import { createHash } from "node:crypto";

/**
 * Turns Amazon orders, transactions and warehouse stock into Brain A events:
 *
 * - order.updated: an order as it stands, with its status, who fulfils it,
 *   its total and how many units it holds, keyed by when Amazon last
 *   updated it;
 * - sale.completed: an order Amazon has taken payment for (unshipped,
 *   partly shipped or shipped), with its lines, in the same shape as the
 *   store's own sales, keyed by order so a later update never counts it
 *   twice;
 * - marketplace.transaction_posted: money Amazon posted to the seller's
 *   account, such as a sale, a fee, a refund or a transfer, with its
 *   breakdown and the order it belongs to;
 * - inventory.counted: units of a SKU Amazon's warehouses can ship now,
 *   with what is inbound, reserved and unsellable.
 *
 * The client never asks for the buyer or the shipping address, and none is
 * kept if Amazon sends one anyway. Amounts are whole cents, parsed from
 * Amazon's decimal strings without floating point.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface AmazonBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface AmazonContext {
  receivedAt: string;
}

export const AMAZON_EVENTS = {
  order: "order.updated",
  sale: "sale.completed",
  transaction: "marketplace.transaction_posted",
  stock: "inventory.counted",
} as const;

/** The fulfillment statuses Amazon gives once the buyer has paid. */
export const AMAZON_PAID_STATUSES: ReadonlySet<string> = new Set(["UNSHIPPED", "PARTIALLY_SHIPPED", "SHIPPED"]);
/** Where stock in Amazon's warehouses is counted. */
export const AMAZON_FBA_LOCATION = "amazon:location:fba";

export interface AmazonPage {
  items: Record<string, unknown>[];
  /** The token for the next page, present only when Amazon gives one. */
  next: string | undefined;
}

export class AmazonShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmazonShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown) => (Array.isArray(value) ? value.map(obj) : []);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const id = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : undefined);
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const word = (value: unknown) => (typeof value === "string" && /^[A-Za-z_]{1,40}$/.test(value) ? value : undefined);
const currency = (value: unknown) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined);
/** A SKU as the seller set it: printable, without control characters. */
const sku = (value: unknown) => (typeof value === "string" && /^[\x20-\x7e]{1,100}$/.test(value) && value.trim() ? value.trim() : undefined);
export const amazonRef = (kind: string, value: string) => `amazon:${kind}:${value}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): AmazonBrainEvent {
  return { id: `amazon_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `amazon:${key}`, payload };
}

/** An ISO time as Amazon gives it, normalized; undefined when it isn't one. */
export function amazonTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * An amount as whole cents: a decimal string such as "49.99" or "-3.5", or a
 * number, rounded half away from zero past the second decimal. Undefined for
 * anything else, so a bad amount is never read as zero.
 */
export function amazonCents(value: unknown): number | undefined {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string") return undefined;
  const m = /^(-)?(\d{1,13})(?:\.(\d{1,20}))?$/.exec(raw.trim());
  if (!m) return undefined;
  const fraction = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  return m[1] && cents !== 0 ? -cents : cents;
}

/** A Money value ({ amount, currencyCode }) or a Currency value ({ currencyAmount, currencyCode }). */
function money(value: unknown): { cents: number | undefined; currency: string | undefined } {
  const m = obj(value);
  return { cents: amazonCents(m.amount ?? m.currencyAmount), currency: currency(m.currencyCode) };
}

/** A count Amazon gives, or undefined when it isn't a whole number of zero or more. */
const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/**
 * One page of a list: `orders` with pagination.nextToken, `transactions`
 * under payload with payload.nextToken, or `inventorySummaries` under
 * payload with a top-level pagination.nextToken. A body without the list
 * throws, so a sync never skips records unseen.
 */
export function amazonPage(body: unknown, kind: "orders" | "transactions" | "inventory"): AmazonPage {
  const b = obj(body);
  const payload = obj(b.payload);
  const items = kind === "orders" ? b.orders : kind === "transactions" ? payload.transactions : payload.inventorySummaries;
  if (!Array.isArray(items)) throw new AmazonShapeError(`Amazon answered without ${kind === "inventory" ? "inventorySummaries" : kind}`);
  const next = kind === "transactions" ? payload.nextToken : obj(b.pagination).nextToken;
  return { items: items.map(obj), next: typeof next === "string" && next ? next : undefined };
}

/** An order as order.updated, plus sale.completed once it is paid and every line can be read. None without an id. */
export function amazonOrderEvents(order: Record<string, unknown>, ctx: AmazonContext): AmazonBrainEvent[] {
  const orderId = id(order?.orderId);
  if (!orderId) return [];
  const createdAt = amazonTime(order.createdTime);
  const updatedAt = amazonTime(order.lastUpdatedTime);
  const fulfillment = obj(order.fulfillment);
  const status = word(fulfillment.fulfillmentStatus);
  const total = money(obj(order.proceeds).grandTotal);
  const channel = obj(order.salesChannel);
  const items = list(order.orderItems);
  const lines = items.map((item) => {
    const product = obj(item.product);
    const asin = id(product.asin);
    return {
      sku: sku(product.sellerSku) ?? (asin ? amazonRef("asin", asin) : undefined),
      quantity: count(item.quantityOrdered),
      unitPriceCents: money(obj(product.price).unitPrice).cents,
    };
  });
  const ref = amazonRef("order", orderId);
  const events = [
    event(`order:${orderId}:${updatedAt ?? digest([status, total])}`, AMAZON_EVENTS.order, updatedAt, ctx.receivedAt, defined({
      orderId: ref,
      createdAt,
      status: status ?? null,
      fulfilledBy: word(fulfillment.fulfilledBy),
      channel: "amazon",
      marketplaceId: id(channel.marketplaceId),
      marketplace: text(channel.marketplaceName, 60),
      currency: total.currency,
      totalCents: total.cents ?? null,
      lineCount: items.length,
      units: lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0),
    })),
  ];
  const sold = lines.filter((l) => l.quantity !== 0);
  const readable = sold.every((l) => l.sku && l.quantity !== undefined && l.quantity > 0 && l.unitPriceCents !== undefined && l.unitPriceCents >= 0);
  if (status && AMAZON_PAID_STATUSES.has(status) && total.cents !== undefined && total.cents > 0 && sold.length && readable) {
    events.push(
      event(`sale:${orderId}`, AMAZON_EVENTS.sale, createdAt, ctx.receivedAt, {
        saleId: ref,
        channel: "online",
        lines: sold.map((l) => ({ sku: l.sku!, quantity: l.quantity!, unitPriceCents: l.unitPriceCents!, discountCents: 0 })),
        totalCents: total.cents,
        // Amazon takes the buyer's payment and pays the seller out later, so the method isn't the store's to know.
        payments: [{ method: "other", amountCents: total.cents }],
        marketplace: "amazon",
        ...(total.currency ? { currency: total.currency } : {}),
      }),
    );
  }
  return events;
}

/** A transaction as marketplace.transaction_posted, or null when it has no date or amount to go by. */
export function amazonTransactionEvent(txn: Record<string, unknown>, ctx: AmazonContext): AmazonBrainEvent | null {
  const postedAt = amazonTime(txn?.postedDate);
  const total = money(txn?.totalAmount);
  if (!postedAt || total.cents === undefined) return null;
  const related = list(txn.relatedIdentifiers);
  const orderId = id(related.find((r) => r.relatedIdentifierName === "ORDER_ID")?.relatedIdentifierValue);
  const groupId = id(related.find((r) => r.relatedIdentifierName === "FINANCIAL_EVENT_GROUP_ID")?.relatedIdentifierValue);
  const breakdowns = list(txn.breakdowns).flatMap((b) => {
    const type = word(b.breakdownType);
    const amount = money(b.breakdownAmount).cents;
    return type && amount !== undefined ? [{ type, amountCents: amount }] : [];
  });
  const status = word(txn.transactionStatus);
  const payload = defined({
    transactionId: id(txn.transactionId) && amazonRef("transaction", id(txn.transactionId)!),
    type: word(txn.transactionType) ?? null,
    status,
    description: text(txn.description, 200),
    postedAt,
    currency: total.currency,
    amountCents: total.cents,
    orderId: orderId && amazonRef("order", orderId),
    groupId: groupId && amazonRef("group", groupId),
    breakdowns,
  });
  // Amazon gives most transactions an id; a deferred one moves to released under the same id, which is a new version.
  const key = id(txn.transactionId) ? `txn:${id(txn.transactionId)}:${status ?? "unknown"}` : `txn:${digest(payload)}`;
  return event(key, AMAZON_EVENTS.transaction, postedAt, ctx.receivedAt, payload);
}

/** A SKU's stock in Amazon's warehouses as inventory.counted, or null without a SKU. */
export function amazonStockEvent(summary: Record<string, unknown>, ctx: AmazonContext): AmazonBrainEvent | null {
  const seller = sku(summary?.sellerSku);
  if (!seller) return null;
  const details = obj(summary.inventoryDetails);
  // What can ship now when Amazon gives the details; its total otherwise.
  const onHand = count(details.fulfillableQuantity) ?? count(summary.totalQuantity);
  const inbound = [details.inboundWorkingQuantity, details.inboundShippedQuantity, details.inboundReceivingQuantity].map(count);
  const countedAt = amazonTime(summary.lastUpdatedTime) ?? ctx.receivedAt;
  const payload = defined({
    sku: seller,
    // A count Amazon gives that isn't a whole number is kept as null, so the inventory schema dead-letters it.
    onHand: onHand ?? null,
    locationId: AMAZON_FBA_LOCATION,
    asin: id(summary.asin),
    fnSku: id(summary.fnSku),
    condition: word(summary.condition),
    totalQuantity: count(summary.totalQuantity),
    inbound: inbound.every((n) => n === undefined) ? undefined : inbound.reduce<number>((s, n) => s + (n ?? 0), 0),
    reserved: count(obj(details.reservedQuantity).totalReservedQuantity),
    unfulfillable: count(obj(details.unfulfillableQuantity).totalUnfulfillableQuantity),
  });
  return event(`count:${seller}:${countedAt.slice(0, 10)}:${digest(payload)}`, AMAZON_EVENTS.stock, countedAt, ctx.receivedAt, payload);
}
