import { createHmac, timingSafeEqual } from "node:crypto";
import {
  customerEvents,
  orderEvents,
  productEvents,
  type ShopifyCustomer,
  type ShopifyEvent,
  type ShopifyOrder,
  type ShopifyProduct,
} from "./normalize.js";

/**
 * Shopify webhooks carry the REST shape (snake_case, numeric ids). They are
 * mapped onto the GraphQL shape the sync reads, so a webhook and a sync of
 * the same record produce the same events and replays count as duplicates.
 */

/** A verified delivery: the `X-Shopify-Topic` header and the parsed body. */
export interface ShopifyWebhookDelivery {
  topic: string;
  payload: Record<string, unknown>;
}

export const SHOPIFY_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/paid",
  "orders/cancelled",
  "orders/fulfilled",
  "refunds/create",
  "products/create",
  "products/update",
  "customers/create",
  "customers/update",
] as const;

/**
 * Checks `X-Shopify-Hmac-SHA256`: base64 HMAC-SHA256 of the raw body, keyed
 * with the app's client secret. Compare before parsing the body.
 */
export function verifyShopifyWebhook(secret: string, rawBody: string | Buffer, hmacHeader: string | undefined): boolean {
  if (!secret || !hmacHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type Rest = Record<string, any>;

const gid = (kind: string, id: unknown) => `gid://shopify/${kind}/${String(id)}`;
const shop = (amount: unknown) => ({ shopMoney: { amount: amount === undefined || amount === null ? "" : String(amount) } });
const upper = (value: unknown) => (typeof value === "string" && value ? value.toUpperCase() : null);

function restLine(l: Rest) {
  return { id: gid("LineItem", l.id), sku: l.sku ?? null, variant: l.variant_id ? { id: gid("ProductVariant", l.variant_id) } : null };
}

function restRefund(r: Rest) {
  return {
    id: gid("Refund", r.id),
    createdAt: r.created_at,
    refundLineItems: {
      nodes: ((r.refund_line_items ?? []) as Rest[]).map((x) => ({ quantity: x.quantity, lineItem: restLine(x.line_item ?? {}), subtotalSet: shop(x.subtotal) })),
    },
  };
}

export function restOrder(o: Rest): ShopifyOrder {
  return {
    id: gid("Order", o.id),
    name: o.name,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    processedAt: o.processed_at ?? null,
    cancelledAt: o.cancelled_at ?? null,
    sourceName: o.source_name ?? null,
    displayFinancialStatus: upper(o.financial_status),
    displayFulfillmentStatus: upper(o.fulfillment_status) ?? "UNFULFILLED",
    paymentGatewayNames: o.payment_gateway_names ?? [],
    currencyCode: o.currency,
    totalPriceSet: shop(o.total_price),
    customer: o.customer?.id ? { id: gid("Customer", o.customer.id) } : null,
    lineItems: {
      nodes: ((o.line_items ?? []) as Rest[]).map((l) => ({
        ...restLine(l),
        quantity: l.quantity,
        originalUnitPriceSet: shop(l.price),
        totalDiscountSet: shop(l.total_discount ?? "0.00"),
      })),
    },
    refunds: ((o.refunds ?? []) as Rest[]).map(restRefund),
    fulfillments: ((o.fulfillments ?? []) as Rest[]).map((f) => ({
      id: gid("Fulfillment", f.id),
      status: upper(f.status) ?? "SUCCESS",
      createdAt: f.created_at,
      updatedAt: f.updated_at ?? f.created_at,
    })),
  };
}

export function restProduct(p: Rest): ShopifyProduct {
  const tags = typeof p.tags === "string" ? p.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : (p.tags ?? []);
  return {
    id: gid("Product", p.id),
    title: p.title,
    status: upper(p.status) ?? "ACTIVE",
    vendor: p.vendor ?? null,
    productType: p.product_type ?? null,
    tags,
    updatedAt: p.updated_at,
    variants: {
      nodes: ((p.variants ?? []) as Rest[]).map((v) => ({
        id: gid("ProductVariant", v.id),
        sku: v.sku ?? null,
        price: String(v.price),
        inventoryQuantity: v.inventory_quantity ?? null,
      })),
    },
  };
}

export function restCustomer(c: Rest): ShopifyCustomer {
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return {
    id: gid("Customer", c.id),
    displayName: name || null,
    updatedAt: c.updated_at,
    emailMarketingConsent: c.email_marketing_consent?.state ? { marketingState: String(c.email_marketing_consent.state).toUpperCase() } : null,
  };
}

/** Events for one verified delivery. Topics the connector doesn't read give none. */
export function shopifyWebhookEvents(delivery: ShopifyWebhookDelivery, receivedAt: string): ShopifyEvent[] {
  const p = delivery.payload ?? {};
  if (delivery.topic.startsWith("orders/")) return orderEvents(restOrder(p), receivedAt);
  if (delivery.topic === "refunds/create") {
    // A refund delivery names its order; only the sale.returned event can be built from it.
    const order = restOrder({ id: p.order_id, refunds: [p] });
    return orderEvents(order, receivedAt).filter((e) => e.type === "sale.returned");
  }
  if (delivery.topic.startsWith("products/")) return productEvents(restProduct(p), receivedAt);
  if (delivery.topic.startsWith("customers/")) return customerEvents(restCustomer(p), receivedAt);
  return [];
}
