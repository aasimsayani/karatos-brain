/**
 * Turns BigCommerce records into Brain A events, in the same types and
 * shapes as the Shopify, Square and Clover connectors, so a BigCommerce sale
 * reads like any other:
 *
 * - orders: order.updated (Shopify's shape), sale.completed once paid and
 *   sale.returned for each refund with product lines (the sales department's
 *   schema);
 * - products with their variants: product.updated (Shopify's shape);
 * - inventory at each location: inventory.counted (the POS connector's shape);
 * - customers: customer.profile_updated, under a keyed reference;
 * - B2B price lists: price_list.updated and price_list.price_updated. No
 *   department owns a price list event yet, so these are neutral types, like
 *   order.updated, kept in BigCommerce's own terms for a wholesale department
 *   to read later.
 *
 * Only what the departments use is kept. No names, email addresses, phone
 * numbers, addresses, IP addresses, customer messages or staff notes.
 */

export type BigCommerceRecord = Record<string, unknown>;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface BigCommerceBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** What normalizing needs from the connector. */
export interface BigCommerceContext {
  receivedAt: string;
  customerRef(id: unknown): string | undefined;
}

/** BigCommerce IDs: positive whole numbers, as numbers or digit strings. */
export function bigCommerceId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && value.length <= 12 && /^[1-9]\d*$/.test(value) ? value : undefined;
}

export const bigCommerceRef = (kind: string, id: string) => `bigcommerce:${kind}:${id}`;
/** The stand-in SKU for a variant without one, as Shopify's connector uses shopify-variant-<id>. */
export const variantSku = (id: string) => `bigcommerce-variant-${id}`;

/** A time BigCommerce wrote (RFC 2822 in v2, ISO 8601 in v3), in UTC. Undefined when missing or unreadable, so the pipeline dead-letters the record. */
export function bigCommerceTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const AMOUNT = /^(-?)(\d{1,12})(?:\.(\d{1,6}))?$/;

/** "125.5000" or 125.5 → 12550, rounded to the cent without floating point. Null for anything that isn't a plain amount. */
export function bigCommerceCents(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) >= 1e12) return null;
    text = value.toFixed(6);
  } else if (typeof value === "string" && value.length <= 24) {
    text = value.trim();
  } else {
    return null;
  }
  const match = AMOUNT.exec(text);
  if (!match) return null;
  const decimals = (match[3] ?? "").padEnd(3, "0");
  const cents = Number(match[2]) * 100 + Number(decimals.slice(0, 2)) + (Number(decimals[2]) >= 5 ? 1 : 0);
  return match[1] && cents !== 0 ? -cents : cents;
}

/** A whole count. Null for fractions and anything unreadable. */
export function bigCommerceCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const list = (value: unknown): BigCommerceRecord[] => (Array.isArray(value) ? value.filter((v): v is BigCommerceRecord => v !== null && typeof v === "object" && !Array.isArray(v)) : []);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const currencyOf = (value: unknown) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined);

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): BigCommerceBrainEvent {
  // A record missing its timestamp gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `bigcommerce_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `bigcommerce:${key}`, payload };
}

/** Order statuses at which the money has been taken: Shipped, Partially Shipped, Refunded, Awaiting Pickup, Awaiting Shipment, Completed, Awaiting Fulfillment, Partially Refunded. */
export const BIGCOMMERCE_PAID_STATUSES = new Set([2, 3, 4, 8, 9, 10, 11, 14]);
/** Refunded and Partially Refunded. */
export const BIGCOMMERCE_REFUNDED_STATUSES = new Set([4, 14]);

/** An order's payment method, as the store's gateway names it, mapped to the sales department's payment methods. */
export function bigCommercePaymentMethod(method: unknown): string {
  const m = typeof method === "string" ? method.slice(0, 60).toLowerCase() : "";
  if (m.includes("gift")) return "gift_card";
  // Store credit is a balance the store holds, not a card.
  if (m.includes("store credit")) return "other";
  if (m.includes("cash")) return "cash";
  if (m.includes("check") || m.includes("cheque")) return "check";
  if (/affirm|klarna|afterpay|sezzle|synchrony|acima|financ/.test(m)) return "financing";
  if (/wire|bank deposit|bank transfer/.test(m)) return "wire";
  if (/card|credit|debit|stripe|paypal|braintree|square|authorize|apple|google|adyen|checkout/.test(m)) return "card";
  return "other";
}

/** Whether an order was rung up in a store. BigCommerce's own and API orders count as online. */
function channelOf(order: BigCommerceRecord): "store" | "online" {
  const source = typeof order.order_source === "string" ? order.order_source.slice(0, 40).toLowerCase() : "";
  return source.includes("pos") ? "store" : "online";
}

/** A line's SKU: its own, or a stable stand-in for a product sold without one. */
function lineSku(orderId: string, line: BigCommerceRecord): string | undefined {
  const sku = text(line.sku, 100);
  if (sku) return sku;
  const variant = bigCommerceId(line.variant_id);
  if (variant) return variantSku(variant);
  const id = bigCommerceId(line.id);
  return id ? `bigcommerce-line-${orderId}-${id}` : undefined;
}

/** What a line's discounts add up to, in cents. */
function discountCents(line: BigCommerceRecord): number | null {
  let total = 0;
  for (const d of list(line.applied_discounts)) {
    const cents = bigCommerceCents(d.amount);
    if (cents === null) return null;
    total += cents;
  }
  return total;
}

/**
 * An order's events: its latest state, the sale once paid, and each refund
 * that returned products. `products` are the order's lines (read from
 * `/v2/orders/{id}/products`) and `refunds` its refunds (read from
 * `/v3/orders/{id}/payment_actions/refunds`).
 */
export function bigCommerceOrderEvents(order: BigCommerceRecord, products: BigCommerceRecord[], refunds: BigCommerceRecord[], ctx: BigCommerceContext): BigCommerceBrainEvent[] {
  const id = bigCommerceId(order?.id);
  if (!id) return [];
  const updatedAt = bigCommerceTime(order.date_modified);
  const statusId = bigCommerceCount(order.status_id);
  const totalCents = bigCommerceCents(order.total_inc_tax);
  const channel = channelOf(order);
  const customerId = ctx.customerRef(order.customer_id);
  const lines = products.filter((l) => bigCommerceCount(l.quantity) !== 0);
  const orderId = bigCommerceRef("order", id);
  const events: BigCommerceBrainEvent[] = [
    event(`order:${id}:${updatedAt ?? "unknown"}`, "order.updated", updatedAt, ctx.receivedAt, defined({
      orderId,
      createdAt: bigCommerceTime(order.date_created),
      status: text(order.status, 60) ?? null,
      statusId,
      channel,
      currency: currencyOf(order.currency_code),
      totalCents,
      refundedCents: bigCommerceCents(order.refunded_amount) ?? 0,
      lineCount: lines.length,
      // Every page of the order's lines is read before its events are made.
      linesComplete: true,
      customerId,
    })),
  ];

  const saleLines = lines.map((l) => ({
    sku: lineSku(id, l),
    quantity: bigCommerceCount(l.quantity),
    unitPriceCents: bigCommerceCents(l.base_price),
    discountCents: discountCents(l),
  }));
  const readable = saleLines.every((l) => l.sku && l.quantity !== null && l.quantity > 0 && l.unitPriceCents !== null && l.unitPriceCents >= 0 && l.discountCents !== null && l.discountCents >= 0);
  // Keyed by order, not by update, so later edits never count the sale twice.
  if (statusId !== null && BIGCOMMERCE_PAID_STATUSES.has(statusId) && totalCents !== null && totalCents > 0 && saleLines.length && readable) {
    events.push(
      event(`sale:${id}`, "sale.completed", bigCommerceTime(order.date_created), ctx.receivedAt, defined({
        saleId: orderId,
        customerId,
        channel,
        lines: saleLines,
        totalCents,
        payments: [{ method: bigCommercePaymentMethod(order.payment_method), amountCents: totalCents }],
      })),
    );
  }

  const skuByLine = new Map(products.flatMap((l) => {
    const lineId = bigCommerceId(l.id);
    const sku = lineSku(id, l);
    return lineId && sku ? [[lineId, sku] as const] : [];
  }));
  for (const refund of refunds) {
    const refundId = bigCommerceId(refund?.id);
    if (!refundId) continue;
    const returned = list(refund.items)
      .filter((item) => item.item_type === "PRODUCT")
      .flatMap((item) => {
        const sku = skuByLine.get(bigCommerceId(item.item_id) ?? "");
        const quantity = bigCommerceCount(item.quantity);
        if (!sku || quantity === null || quantity <= 0) return [];
        return [{ sku, quantity, refundCents: bigCommerceCents(item.requested_amount) ?? 0 }];
      });
    // Refunds of shipping, handling or a goodwill amount have no product lines; the order's status records them.
    if (!returned.length) continue;
    events.push(
      event(`refund:${refundId}`, "sale.returned", bigCommerceTime(refund.created), ctx.receivedAt, {
        saleId: orderId,
        returnId: bigCommerceRef("refund", refundId),
        lines: returned,
      }),
    );
  }
  return events;
}

/** A product with its variants, in Shopify's product.updated shape. */
export function bigCommerceProductEvents(product: BigCommerceRecord, ctx: BigCommerceContext): BigCommerceBrainEvent[] {
  const id = bigCommerceId(product?.id);
  if (!id) return [];
  const updatedAt = bigCommerceTime(product.date_modified);
  const productType = typeof product.type === "string" && /^[a-z_]{1,20}$/.test(product.type) ? product.type : null;
  return [
    event(`product:${id}:${updatedAt ?? "unknown"}`, "product.updated", updatedAt, ctx.receivedAt, {
      productId: bigCommerceRef("product", id),
      title: text(product.name) ?? `BigCommerce product ${id}`,
      status: product.is_visible === false ? "HIDDEN" : product.availability === "disabled" ? "DISABLED" : "ACTIVE",
      vendor: null,
      productType,
      tags: [],
      variants: list(product.variants).flatMap((v) => {
        const vid = bigCommerceId(v.id);
        if (!vid) return [];
        // A variant without its own price sells at the product's.
        const price = v.price ?? v.calculated_price ?? product.price;
        return [{ variantId: bigCommerceRef("variant", vid), sku: text(v.sku, 100) ?? variantSku(vid), priceCents: bigCommerceCents(price), inventoryQuantity: bigCommerceCount(v.inventory_level) }];
      }),
    }),
  ];
}

/**
 * What each location has on hand of one variant, in the POS connector's
 * inventory.counted shape. BigCommerce reports no count time, so the count
 * is dated at the sync pass that read it; it is keyed by that day and the
 * number on hand, so a pass stores a count only when it changed that day.
 */
export function bigCommerceInventoryEvents(item: BigCommerceRecord, countedAt: string, ctx: BigCommerceContext): BigCommerceBrainEvent[] {
  const identity = (item?.identity ?? {}) as BigCommerceRecord;
  const variant = bigCommerceId(identity.variant_id);
  if (!variant) return [];
  const sku = text(identity.sku, 100) ?? variantSku(variant);
  const day = countedAt.slice(0, 10);
  return list(item.locations).flatMap((l) => {
    const location = bigCommerceId(l.location_id);
    if (!location) return [];
    // A fractional or negative count is kept as BigCommerce reports it (or null), so the inventory schema dead-letters it.
    const onHand = bigCommerceCount(l.total_inventory_onhand);
    return [
      event(`count:${variant}:${location}:${day}:${onHand ?? "unknown"}`, "inventory.counted", countedAt, ctx.receivedAt, {
        sku,
        onHand,
        variantId: bigCommerceRef("variant", variant),
        locationId: bigCommerceRef("location", location),
      }),
    ];
  });
}

/**
 * A customer profile under its keyed reference. The name the departments
 * see is a label made from the reference, never the customer's own.
 * BigCommerce's customer record doesn't say whether they agreed to email
 * marketing (newsletter sign-ups are kept apart), so consent is never assumed.
 */
export function bigCommerceCustomerEvent(customer: BigCommerceRecord, ctx: BigCommerceContext): BigCommerceBrainEvent | null {
  const ref = ctx.customerRef(customer?.id);
  if (!ref) return null;
  const updatedAt = bigCommerceTime(customer.date_modified);
  const mac = ref.slice(ref.lastIndexOf(":") + 1);
  return event(`customer:${mac}:${updatedAt ?? "unknown"}`, "customer.profile_updated", updatedAt, ctx.receivedAt, {
    customerId: ref,
    name: `BigCommerce customer ${mac.slice(0, 8)}`,
    marketingConsent: false,
  });
}

/** A B2B price list: its name and whether it is active. */
export function bigCommercePriceListEvent(priceList: BigCommerceRecord, ctx: BigCommerceContext): BigCommerceBrainEvent | null {
  const id = bigCommerceId(priceList?.id);
  if (!id) return null;
  const updatedAt = bigCommerceTime(priceList.date_modified);
  return event(`price_list:${id}:${updatedAt ?? "unknown"}`, "price_list.updated", updatedAt, ctx.receivedAt, {
    priceListId: bigCommerceRef("price_list", id),
    name: text(priceList.name, 100) ?? `BigCommerce price list ${id}`,
    active: priceList.active === true,
  });
}

const TIER_TYPES = new Set(["fixed", "price", "percent"]);

/** One variant's price on a price list, in one currency, with its quantity tiers. */
export function bigCommercePriceRecordEvent(record: BigCommerceRecord, ctx: BigCommerceContext): BigCommerceBrainEvent | null {
  const list_ = bigCommerceId(record?.price_list_id);
  const variant = bigCommerceId(record?.variant_id);
  const currency = currencyOf(typeof record?.currency === "string" ? record.currency.toUpperCase() : undefined);
  if (!list_ || !variant || !currency) return null;
  const updatedAt = bigCommerceTime(record.date_modified);
  const product = bigCommerceId(record.product_id);
  return event(`price:${list_}:${variant}:${currency}:${updatedAt ?? "unknown"}`, "price_list.price_updated", updatedAt, ctx.receivedAt, defined({
    priceListId: bigCommerceRef("price_list", list_),
    variantId: bigCommerceRef("variant", variant),
    productId: product && bigCommerceRef("product", product),
    sku: text(record.sku, 100) ?? variantSku(variant),
    currency,
    priceCents: bigCommerceCents(record.price),
    salePriceCents: bigCommerceCents(record.sale_price),
    retailPriceCents: bigCommerceCents(record.retail_price),
    mapPriceCents: bigCommerceCents(record.map_price),
    bulkPricingTiers: list(record.bulk_pricing_tiers).flatMap((t) => {
      const min = bigCommerceCount(t.quantity_min);
      const max = bigCommerceCount(t.quantity_max);
      const type = typeof t.type === "string" && TIER_TYPES.has(t.type) ? t.type : undefined;
      const amount = typeof t.amount === "number" && Number.isFinite(t.amount) ? t.amount : undefined;
      return min !== null && type && amount !== undefined ? [{ quantityMin: min, quantityMax: max, type, amount }] : [];
    }),
  }));
}
