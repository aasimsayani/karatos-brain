/**
 * Turns Shopify records into Brain A events. Where a retail department owns
 * an event type (sale.completed, sale.returned, customer.profile_updated) the
 * payload follows that department's schema; everything else keeps Shopify's
 * own shape under a Shopify-neutral type (order.updated, product.updated,
 * fulfillment.updated). Only what the departments use is kept: no email
 * addresses, phone numbers or street addresses.
 */

export interface Money {
  shopMoney: { amount: string; currencyCode?: string };
}

export interface ShopifyLineItem {
  id: string;
  sku: string | null;
  quantity: number;
  variant: { id: string } | null;
  originalUnitPriceSet: Money;
  totalDiscountSet: Money;
}

export interface ShopifyRefund {
  id: string;
  createdAt: string;
  refundLineItems: {
    nodes: { quantity: number; lineItem: { id: string; sku: string | null; variant: { id: string } | null }; subtotalSet: Money }[];
  };
}

export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  sourceName: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  paymentGatewayNames: string[];
  currencyCode: string;
  totalPriceSet: Money;
  customer: { id: string } | null;
  lineItems: { nodes: ShopifyLineItem[]; pageInfo?: { hasNextPage: boolean } };
  refunds: ShopifyRefund[];
  fulfillments: { id: string; status: string; createdAt: string; updatedAt?: string }[];
}

export interface ShopifyVariant {
  id: string;
  sku: string | null;
  price: string;
  inventoryQuantity: number | null;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  updatedAt: string;
  variants: { nodes: ShopifyVariant[] };
}

export interface ShopifyCustomer {
  id: string;
  displayName: string | null;
  updatedAt: string;
  emailMarketingConsent: { marketingState: string } | null;
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface ShopifyEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** `gid://shopify/Order/123` → `123`. Plain numeric ids (from webhooks) pass through. */
export function legacyId(gid: string | number): string {
  const text = String(gid);
  return text.slice(text.lastIndexOf("/") + 1);
}

/** "125.50" → 12550, without floating point. Null for anything that isn't a plain amount. */
export function toCents(amount: string | number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(String(amount).trim());
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -cents : cents;
}

/** Financial statuses at which the money has actually been taken. */
const PAID = new Set(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

/** Shopify payment gateway names, lowercased, mapped to the sales department's payment methods. */
export function paymentMethod(gateway: string | undefined): string {
  const g = (gateway ?? "").toLowerCase();
  if (g === "gift_card") return "gift_card";
  if (g === "cash" || g.includes("cash on delivery")) return "cash";
  if (/affirm|klarna|afterpay|installments|sezzle|synchrony|acima/.test(g)) return "financing";
  if (/shopify_payments|stripe|paypal|authorize|braintree|square|card|apple|google|shop_pay/.test(g)) return "card";
  return "other";
}

export const customerRef = (gid: string) => `shopify:customer:${legacyId(gid)}`;
export const saleRef = (gid: string) => `shopify:order:${legacyId(gid)}`;

/** A line's SKU, or a stable stand-in for products sold without one. */
function lineSku(line: { id: string; sku: string | null; variant: { id: string } | null }): string {
  if (line.sku && line.sku.trim()) return line.sku.trim();
  return line.variant ? `shopify-variant-${legacyId(line.variant.id)}` : `shopify-line-${legacyId(line.id)}`;
}

function event(key: string, type: string, occurredAt: string | null | undefined, receivedAt: string, payload: Record<string, unknown>): ShopifyEvent {
  // A record missing its timestamp gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `shopify_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt: occurredAt ?? undefined, receivedAt, idempotencyKey: `shopify:${key}`, payload };
}

/** An order's events: its latest state, the sale once paid, each refund with lines, and each fulfillment. */
export function orderEvents(order: ShopifyOrder, receivedAt: string): ShopifyEvent[] {
  const id = legacyId(order.id ?? "");
  const totalCents = toCents(order.totalPriceSet?.shopMoney?.amount);
  const lines = (order.lineItems?.nodes ?? []).filter((l) => l.quantity > 0);
  const linesComplete = !order.lineItems?.pageInfo?.hasNextPage;
  const channel = order.sourceName === "pos" ? "store" : "online";
  const customerId = order.customer ? customerRef(order.customer.id) : undefined;
  const events: ShopifyEvent[] = [
    event(`order:${id}:${order.updatedAt}`, "order.updated", order.updatedAt, receivedAt, {
      orderId: saleRef(order.id ?? ""),
      name: order.name,
      createdAt: order.createdAt,
      financialStatus: order.displayFinancialStatus,
      fulfillmentStatus: order.displayFulfillmentStatus,
      cancelledAt: order.cancelledAt,
      channel,
      currency: order.currencyCode,
      totalCents,
      lineCount: lines.length,
      linesComplete,
      ...(customerId ? { customerId } : {}),
    }),
  ];

  const saleLines = lines.map((l) => ({
    sku: lineSku(l),
    quantity: l.quantity,
    unitPriceCents: toCents(l.originalUnitPriceSet?.shopMoney?.amount),
    discountCents: toCents(l.totalDiscountSet?.shopMoney?.amount) ?? 0,
  }));
  const priced = saleLines.every((l) => l.unitPriceCents !== null && l.unitPriceCents >= 0);
  // Keyed by order, not by update, so later edits never count the sale twice.
  if (PAID.has(order.displayFinancialStatus ?? "") && totalCents !== null && totalCents > 0 && saleLines.length && linesComplete && priced) {
    events.push(
      event(`sale:${id}`, "sale.completed", order.processedAt ?? order.createdAt, receivedAt, {
        saleId: saleRef(order.id),
        ...(customerId ? { customerId } : {}),
        channel,
        lines: saleLines,
        totalCents,
        payments: [{ method: paymentMethod(order.paymentGatewayNames?.[0]), amountCents: totalCents }],
      }),
    );
  }

  for (const refund of order.refunds ?? []) {
    const returned = (refund.refundLineItems?.nodes ?? [])
      .filter((r) => r.quantity > 0)
      .map((r) => ({ sku: lineSku(r.lineItem), quantity: r.quantity, refundCents: toCents(r.subtotalSet?.shopMoney?.amount) ?? 0 }));
    // Refunds of shipping or a goodwill amount have no lines; the order's status records them.
    if (!returned.length) continue;
    events.push(
      event(`refund:${legacyId(refund.id)}`, "sale.returned", refund.createdAt, receivedAt, {
        saleId: saleRef(order.id),
        returnId: `shopify:refund:${legacyId(refund.id)}`,
        lines: returned,
      }),
    );
  }

  for (const f of order.fulfillments ?? []) {
    events.push(
      event(`fulfillment:${legacyId(f.id)}:${f.status}`, "fulfillment.updated", f.updatedAt ?? f.createdAt, receivedAt, {
        orderId: saleRef(order.id),
        fulfillmentId: `shopify:fulfillment:${legacyId(f.id)}`,
        status: f.status,
      }),
    );
  }
  return events;
}

export function productEvents(product: ShopifyProduct, receivedAt: string): ShopifyEvent[] {
  const id = legacyId(product.id ?? "");
  return [
    event(`product:${id}:${product.updatedAt}`, "product.updated", product.updatedAt, receivedAt, {
      productId: `shopify:product:${id}`,
      title: product.title,
      status: product.status,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags ?? [],
      variants: (product.variants?.nodes ?? []).map((v) => ({
        variantId: `shopify:variant:${legacyId(v.id)}`,
        sku: lineSku({ id: v.id, sku: v.sku, variant: { id: v.id } }),
        priceCents: toCents(v.price),
        inventoryQuantity: v.inventoryQuantity,
      })),
    }),
  ];
}

export function customerEvents(customer: ShopifyCustomer, receivedAt: string): ShopifyEvent[] {
  const id = legacyId(customer.id ?? "");
  return [
    event(`customer:${id}:${customer.updatedAt}`, "customer.profile_updated", customer.updatedAt, receivedAt, {
      customerId: customerRef(customer.id ?? ""),
      name: customer.displayName?.trim() || `Shopify customer ${id}`,
      marketingConsent: customer.emailMarketingConsent?.marketingState === "SUBSCRIBED",
    }),
  ];
}
