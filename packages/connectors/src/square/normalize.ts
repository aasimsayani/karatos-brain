/**
 * Turns Square records into Brain A events, in the same types and shapes as
 * the Shopify, POS and Stripe connectors, so a Square sale reads like any
 * other:
 *
 * - orders: order.updated (Shopify's shape), sale.completed for a completed
 *   sale and sale.returned for each return (the sales department's schema);
 * - payments and refunds: payment.charge_updated and payment.refund_updated
 *   (Stripe's shape);
 * - catalog items: product.updated (Shopify's shape), with each variation's
 *   SKU and price;
 * - inventory counts: inventory.counted (the POS connector's shape);
 * - customers: customer.profile_updated, under a keyed reference.
 *
 * Only what the departments use is kept. No names, email addresses, phone
 * numbers, addresses, notes, ticket names or receipt links; of a card, only
 * its brand. Square writes money as whole amounts in the smallest unit, so
 * cents pass through unchanged.
 */

export interface SquareMoney {
  amount?: unknown;
  currency?: unknown;
}

export type SquareRecord = Record<string, unknown>;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface SquareBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** What normalizing needs from the connector: SKUs for catalog variations and keyed customer references. */
export interface SquareContext {
  receivedAt: string;
  /** The SKU of a catalog variation, or a stable stand-in when it has none. */
  sku(variationId: string): string;
  customerRef(id: unknown): string | undefined;
}

/** Square's object IDs. Anything else is dropped, since there is nothing safe to key it by. */
const ID = /^[A-Za-z0-9_-]+$/;
export const squareId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 192 && ID.test(value) ? value : undefined;

export const squareRef = (kind: string, id: string) => `square:${kind}:${id}`;
/** The stand-in SKU for a variation without one, as Shopify's connector uses shopify-variant-<id>. */
export const variationSku = (id: string) => `square-variation-${id}`;

/** An RFC 3339 time Square wrote, normalized to UTC. Undefined when missing or unreadable, so the pipeline dead-letters the record. */
export function squareTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A Money amount in the smallest unit. Null for anything that isn't a whole number. */
export function squareCents(money: unknown): number | null {
  const amount = (money as SquareMoney | undefined)?.amount;
  return typeof amount === "number" && Number.isSafeInteger(amount) ? amount : null;
}

const currencyOf = (money: unknown) => {
  const c = (money as SquareMoney | undefined)?.currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : undefined;
};

/** A whole item count from Square's decimal-string quantity. Null for measurements and anything unreadable. */
export function squareQuantity(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 12) return null;
  return /^-?\d{1,9}$/.test(value) ? Number(value) : null;
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
/** Square's enum values: upper-case words joined by underscores. */
const enumValue = (value: unknown, max = 40) => (typeof value === "string" && value.length <= max && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : undefined);
const list = (value: unknown): SquareRecord[] => (Array.isArray(value) ? value.filter((v): v is SquareRecord => v !== null && typeof v === "object") : []);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): SquareBrainEvent {
  // A record missing its timestamp gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `square_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `square:${key}`, payload };
}

/** Square tender and payment source types mapped to the sales department's payment methods. */
export function squarePaymentMethod(type: unknown): string {
  switch (enumValue(type)) {
    case "CARD":
    case "THIRD_PARTY_CARD":
      return "card";
    case "CASH":
      return "cash";
    case "SQUARE_GIFT_CARD":
      return "gift_card";
    case "BUY_NOW_PAY_LATER":
      return "financing";
    case "BANK_ACCOUNT":
      return "wire";
    default:
      // WALLET (Cash App and the like), SQUARE_ACCOUNT (house accounts), EXTERNAL and OTHER.
      return "other";
  }
}

/** Where an order was sold. Square Online and API orders count as online; everything else is the counter. */
function channelOf(order: SquareRecord): "store" | "online" {
  const name = text((order.source as SquareRecord | undefined)?.name, 60)?.toLowerCase() ?? "";
  return /online|web|ecom/.test(name) ? "online" : "store";
}

/** A line's SKU: its variation's, or a stand-in for an amount rung up without a catalog item. */
function lineSku(ctx: SquareContext, orderId: string, line: SquareRecord): string | undefined {
  const variation = squareId(line.catalog_object_id);
  if (variation) return ctx.sku(variation);
  const uid = squareId(line.uid);
  return uid ? `square-line-${orderId}-${uid}` : undefined;
}

/** The catalog variation IDs an order's sale and return lines point at, for looking up their SKUs first. */
export function orderVariationIds(order: SquareRecord): string[] {
  const lines = [...list(order.line_items), ...list(order.returns).flatMap((r) => list(r.return_line_items))];
  return lines.flatMap((l) => squareId(l.catalog_object_id) ?? []);
}

/** An order's events: its latest state, the sale once completed, and each return in it. */
export function squareOrderEvents(order: SquareRecord, ctx: SquareContext): SquareBrainEvent[] {
  const id = squareId(order?.id);
  if (!id) return [];
  const updatedAt = squareTime(order.updated_at);
  const state = enumValue(order.state);
  const totalCents = squareCents(order.total_money);
  const channel = channelOf(order);
  const tenders = list(order.tenders);
  const customerId = ctx.customerRef(order.customer_id) ?? tenders.map((t) => ctx.customerRef(t.customer_id)).find(Boolean);
  const lines = list(order.line_items);
  const events: SquareBrainEvent[] = [
    event(`order:${id}:${updatedAt ?? "unknown"}`, "order.updated", updatedAt, ctx.receivedAt, defined({
      orderId: squareRef("order", id),
      locationId: squareId(order.location_id) && squareRef("location", squareId(order.location_id)!),
      createdAt: squareTime(order.created_at),
      state,
      cancelledAt: state === "CANCELED" ? updatedAt : undefined,
      channel,
      currency: currencyOf(order.total_money),
      totalCents,
      lineCount: lines.length,
      // Square returns every line of an order.
      linesComplete: true,
      customerId,
    })),
  ];
  const soldAt = squareTime(order.closed_at) ?? squareTime(order.created_at);

  const saleLines = lines.map((l) => ({
    sku: lineSku(ctx, id, l),
    quantity: squareQuantity(l.quantity),
    unitPriceCents: squareCents(l.base_price_money),
    discountCents: squareCents(l.total_discount_money) ?? 0,
  }));
  const readable = saleLines.every((l) => l.sku && l.quantity !== null && l.quantity > 0 && l.unitPriceCents !== null && l.unitPriceCents >= 0);
  const payments = tenders
    .filter((t) => enumValue(t.type) !== "NO_SALE")
    .flatMap((t) => {
      const amountCents = squareCents(t.amount_money);
      return amountCents !== null && amountCents > 0 ? [{ method: squarePaymentMethod(t.type), amountCents }] : [];
    });
  // Keyed by order, not by update, so later edits never count the sale twice.
  if (state === "COMPLETED" && totalCents !== null && totalCents > 0 && saleLines.length && readable) {
    events.push(
      event(`sale:${id}`, "sale.completed", soldAt, ctx.receivedAt, defined({
        saleId: squareRef("order", id),
        customerId,
        channel,
        lines: saleLines,
        totalCents,
        payments: payments.length ? payments : [{ method: "other", amountCents: totalCents }],
      })),
    );
  }

  if (state === "COMPLETED") {
    for (const ret of list(order.returns)) {
      const uid = squareId(ret.uid);
      const returned = list(ret.return_line_items).map((l) => ({
        sku: lineSku(ctx, id, l) ?? "",
        quantity: squareQuantity(l.quantity),
        refundCents: squareCents(l.total_money),
      }));
      if (!uid || !returned.length) continue;
      // An unlinked return has no original sale; it is recorded against the return's own order.
      const source = squareId(ret.source_order_id) ?? id;
      events.push(
        event(`return:${id}:${uid}`, "sale.returned", soldAt, ctx.receivedAt, {
          saleId: squareRef("order", source),
          returnId: squareRef("return", `${id}:${uid}`),
          lines: returned,
        }),
      );
    }
  }
  return events;
}

/** A payment's state, in the Stripe connector's shape. The key moves with updated_at, so each change is stored once. */
export function squarePaymentEvent(payment: SquareRecord, ctx: SquareContext): SquareBrainEvent | null {
  const id = squareId(payment?.id);
  if (!id) return null;
  const status = enumValue(payment.status);
  const updatedAt = squareTime(payment.updated_at);
  const total = squareCents(payment.total_money);
  const completed = status === "COMPLETED";
  const card = (payment.card_details as SquareRecord | undefined)?.card as SquareRecord | undefined;
  const order = squareId(payment.order_id);
  const location = squareId(payment.location_id);
  return event(`payment:${id}:${updatedAt ?? "unknown"}`, "payment.charge_updated", squareTime(payment.created_at), ctx.receivedAt, defined({
    chargeId: squareRef("payment", id),
    status: status?.toLowerCase() ?? null,
    paid: completed,
    captured: completed,
    amountCents: total,
    capturedCents: completed ? total : 0,
    refundedCents: squareCents(payment.refunded_money) ?? 0,
    currency: currencyOf(payment.total_money)?.toLowerCase(),
    method: squarePaymentMethod(payment.source_type),
    // The brand only: never the last four digits, expiry, BIN or fingerprint.
    cardBrand: enumValue(card?.card_brand, 30) ?? null,
    orderId: order && squareRef("order", order),
    locationId: location && squareRef("location", location),
    customerId: ctx.customerRef(payment.customer_id),
  }));
}

/** A refund's state, in the Stripe connector's shape. Square's reason is free text staff type, so it isn't kept. */
export function squareRefundEvent(refund: SquareRecord, ctx: SquareContext): SquareBrainEvent | null {
  const id = squareId(refund?.id);
  if (!id) return null;
  const status = enumValue(refund.status);
  const payment = squareId(refund.payment_id);
  const order = squareId(refund.order_id);
  return event(`refund:${id}:${status ?? "unknown"}`, "payment.refund_updated", squareTime(refund.created_at), ctx.receivedAt, defined({
    refundId: squareRef("refund", id),
    chargeId: payment && squareRef("payment", payment),
    orderId: order && squareRef("order", order),
    amountCents: squareCents(refund.amount_money),
    currency: currencyOf(refund.amount_money)?.toLowerCase(),
    status: status?.toLowerCase() ?? null,
    reason: null,
  }));
}

/** SKUs a catalog item's variations carry, for the connector's SKU lookups. */
export function itemVariationSkus(item: SquareRecord): [string, string | null][] {
  const data = (item?.item_data ?? {}) as SquareRecord;
  return list(data.variations).flatMap((v) => {
    const id = squareId(v.id);
    return id ? [[id, text((v.item_variation_data as SquareRecord | undefined)?.sku, 100) ?? null] as [string, string | null]] : [];
  });
}

/** A catalog item with its variations, in Shopify's product.updated shape. Other catalog object types give none. */
export function squareItemEvents(item: SquareRecord, ctx: SquareContext): SquareBrainEvent[] {
  const id = squareId(item?.id);
  if (!id || item.type !== "ITEM") return [];
  const data = (item.item_data ?? {}) as SquareRecord;
  const updatedAt = squareTime(item.updated_at);
  const status = item.is_deleted === true ? "DELETED" : data.is_archived === true ? "ARCHIVED" : "ACTIVE";
  return [
    event(`product:${id}:${updatedAt ?? "unknown"}:${status}`, "product.updated", updatedAt, ctx.receivedAt, {
      productId: squareRef("item", id),
      title: text(data.name) ?? `Square item ${id}`,
      status,
      vendor: null,
      productType: enumValue(data.product_type) ?? null,
      tags: [],
      variants: list(data.variations).flatMap((v) => {
        const vid = squareId(v.id);
        if (!vid) return [];
        const vd = (v.item_variation_data ?? {}) as SquareRecord;
        // Counts come from the inventory stream, per location.
        return [{ variantId: squareRef("variation", vid), sku: text(vd.sku, 100) ?? variationSku(vid), priceCents: squareCents(vd.price_money), inventoryQuantity: null }];
      }),
    }),
  ];
}

/** What a location had on hand of a variation, in the POS connector's inventory.counted shape. */
export function squareCountEvent(count: SquareRecord, ctx: SquareContext): SquareBrainEvent | null {
  const variation = squareId(count?.catalog_object_id);
  const location = squareId(count?.location_id);
  if (!variation || !location || count.state !== "IN_STOCK") return null;
  const at = squareTime(count.calculated_at);
  return event(`count:${variation}:${location}:${at ?? "unknown"}`, "inventory.counted", at, ctx.receivedAt, {
    sku: ctx.sku(variation),
    // A fractional or negative count is kept as Square reports it (or null), so the inventory schema dead-letters it.
    onHand: squareQuantity(count.quantity),
    variantId: squareRef("variation", variation),
    locationId: squareRef("location", location),
  });
}

/**
 * A customer profile under its keyed reference. The name the departments
 * see is a label made from the reference, never the customer's own. Square
 * records only whether a customer unsubscribed from email, not that they
 * agreed to it, so consent is never assumed.
 */
export function squareCustomerEvent(customer: SquareRecord, ctx: SquareContext): SquareBrainEvent | null {
  const ref = ctx.customerRef(customer?.id);
  if (!ref) return null;
  const updatedAt = squareTime(customer.updated_at);
  const mac = ref.slice(ref.lastIndexOf(":") + 1);
  return event(`customer:${mac}:${updatedAt ?? "unknown"}`, "customer.profile_updated", updatedAt, ctx.receivedAt, {
    customerId: ref,
    name: `Square customer ${mac.slice(0, 8)}`,
    marketingConsent: false,
  });
}
