import { LIGHTSPEED_ID, type LightspeedRecord } from "./client.js";

/**
 * Lightspeed Retail (X-Series) records in the shapes the Square connector
 * gives, so the sales, inventory and clienteling departments read either
 * POS the same way:
 *
 * - a sale becomes order.updated for each version, sale.completed once it is
 *   closed, and sale.returned for the lines it took back;
 * - a product becomes product.updated with its one variant;
 * - an inventory record becomes inventory.counted for its outlet;
 * - a customer becomes customer.profile_updated under a keyed reference.
 *
 * No customer names, emails, phone numbers, birthdays, addresses or notes
 * are kept, nor staff names, sale notes, gift card numbers or costs.
 */

export interface LightspeedBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface LightspeedContext {
  receivedAt: string;
  /** The keyed reference for a customer ID. */
  customerRef(id: unknown): string | undefined;
  /** A product's SKU, or a stand-in when the connector doesn't know it. */
  sku(productId: string): string;
}

/** Lightspeed's ID for an object, lower-cased, or undefined for anything else. */
export function lightspeedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return LIGHTSPEED_ID.test(id) ? id : undefined;
}

export const lightspeedRef = (kind: string, id: string) => `lightspeed:${kind}:${id}`;
/** The SKU used for a product whose own SKU isn't known. */
export const lightspeedProductSku = (id: string) => `lightspeed-product-${id}`;

/** A time Lightspeed wrote (UTC, with or without an offset), as an ISO time; undefined when it can't be read. */
export function lightspeedTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!m) return undefined;
  const fraction = m[3] ? m[3].slice(0, 4) : "";
  const zone = !m[4] || m[4] === "Z" ? "Z" : m[4].includes(":") ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  const at = Date.parse(`${m[1]}T${m[2]}${fraction}${zone}`);
  if (Number.isNaN(at)) return undefined;
  const iso = new Date(at).toISOString();
  // A day or time that doesn't exist (February 30th, 25:00) is turned down rather than rolled over.
  return zone === "Z" && iso.slice(0, 19) !== `${m[1]}T${m[2]}` ? undefined : iso;
}

/** A dollar amount (a number or a decimal string) in cents; null for anything else. */
export function lightspeedCents(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^-?\d{1,10}(\.\d{1,8})?$/.test(value.trim())) n = Number(value.trim());
  else return null;
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) return null;
  return Math.round(n * 100) + 0;
}

/** A whole item count; null for measured or unreadable quantities. */
export function lightspeedQuantity(value: unknown): number | null {
  const n = typeof value === "string" && /^-?\d{1,9}(\.0+)?$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= 1e9 ? n + 0 : null;
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
const list = (value: unknown): LightspeedRecord[] => (Array.isArray(value) ? value.filter((v): v is LightspeedRecord => v !== null && typeof v === "object" && !Array.isArray(v)) : []);
const record = (value: unknown): LightspeedRecord => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as LightspeedRecord) : {});
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A record's version: on the record itself, or under _metadata for sales. */
export function lightspeedVersion(r: LightspeedRecord): number | undefined {
  const v = r.version ?? record(r._metadata).version;
  return Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined;
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): LightspeedBrainEvent {
  // A record missing its time gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `lightspeed_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `lightspeed:${key}`, payload };
}

/**
 * A payment type's name mapped to the sales department's methods. Stores
 * name their payment types themselves, so this reads the usual words and
 * calls the rest other.
 */
export function lightspeedPaymentMethod(name: unknown): string {
  const n = typeof name === "string" ? name.toLowerCase() : "";
  if (/gift/.test(n)) return "gift_card";
  if (/store credit|on account|loyalty|voucher/.test(n)) return "other";
  if (/cash/.test(n)) return "cash";
  if (/che(ck|que)/.test(n)) return "check";
  if (/afterpay|affirm|klarna|layby|lay-by|layaway|financ|synchrony|zip/.test(n)) return "financing";
  if (/wire|bank transfer|ach/.test(n)) return "wire";
  if (/card|credit|debit|eftpos|visa|master|amex|american express|discover|tap/.test(n)) return "card";
  return "other";
}

/** Where a sale was made: online when Lightspeed says it came from the web store, otherwise the counter. */
function channelOf(sale: LightspeedRecord): "store" | "online" {
  const type = text(record(sale.source).type, 60)?.toLowerCase() ?? "";
  return /ecom|web|online/.test(type) ? "online" : "store";
}

interface Line {
  sku: string;
  quantity: number | null;
  priceCents: number | null;
  discountCents: number | null;
  totalCents: number | null;
}

function lineOf(line: LightspeedRecord, ctx: LightspeedContext, saleId: string, index: number): Line {
  const product = record(line.product);
  const productId = lightspeedId(product.id);
  const pricing = record(line.pricing);
  const sku = text(product.sku, 100) ?? (productId ? ctx.sku(productId) : `lightspeed-line-${saleId}-${lightspeedId(line.id) ?? index}`);
  const quantity = lightspeedQuantity(line.quantity);
  // Lightspeed's price is the unit price after its discount, and discount the unit discount, both before tax.
  const price = lightspeedCents(pricing.price);
  const unitDiscount = lightspeedCents(pricing.discount) ?? 0;
  const discountTotal = lightspeedCents(pricing.discount_total);
  return {
    sku,
    quantity,
    priceCents: price === null ? null : price + unitDiscount,
    discountCents: discountTotal ?? (quantity === null ? null : unitDiscount * Math.abs(quantity)),
    totalCents: lightspeedCents(pricing.total),
  };
}

/**
 * A sale's events. Lines sold become sale.completed once the sale is
 * closed; lines taken back (a negative quantity) become sale.returned, so
 * an exchange gives both.
 */
export function lightspeedSaleEvents(sale: LightspeedRecord, ctx: LightspeedContext): LightspeedBrainEvent[] {
  const id = lightspeedId(sale?.id);
  if (!id) return [];
  const version = lightspeedVersion(sale);
  const updatedAt = lightspeedTime(sale.updated_at);
  const deleted = lightspeedTime(sale.deleted_at);
  const rawState = typeof sale.state === "string" && /^[a-z_]{1,20}$/.test(sale.state) ? sale.state : undefined;
  const state = deleted ? "DELETED" : rawState?.toUpperCase();
  const totals = record(sale.totals);
  const totalCents = lightspeedCents(totals.price_incl_tax);
  const soldAt = lightspeedTime(sale.date);
  const customerId = ctx.customerRef(sale.customer_id);
  const outlet = lightspeedId(record(sale.source).outlet_id);
  const register = lightspeedId(record(sale.source).register_id);
  const channel = channelOf(sale);
  const items = list(sale.line_items);
  const events: LightspeedBrainEvent[] = [
    event(`order:${id}:${version ?? updatedAt ?? "unknown"}`, "order.updated", updatedAt, ctx.receivedAt, defined({
      orderId: lightspeedRef("sale", id),
      locationId: outlet && lightspeedRef("outlet", outlet),
      registerId: register && lightspeedRef("register", register),
      createdAt: lightspeedTime(sale.created_at),
      state,
      cancelledAt: state === "VOIDED" || state === "DELETED" ? (deleted ?? updatedAt) : undefined,
      channel,
      totalCents,
      lineCount: items.length,
      // Lightspeed returns every line of a sale.
      linesComplete: true,
      customerId,
    })),
  ];
  if (state !== "CLOSED") return events;

  const lines = items.map((l, i) => lineOf(l, ctx, id, i));
  const sold = lines.filter((l) => l.quantity === null || l.quantity > 0);
  const returned = lines.filter((l) => l.quantity !== null && l.quantity < 0);
  const payments = list(sale.payments)
    .filter((p) => !lightspeedTime(p.deleted_at))
    .flatMap((p) => {
      const amountCents = lightspeedCents(p.amount);
      return amountCents !== null && amountCents > 0 ? [{ method: lightspeedPaymentMethod(record(p.type).name), amountCents }] : [];
    });

  // Keyed by sale, not by version, so a later edit never counts the sale twice.
  if (sold.length && totalCents !== null && totalCents > 0) {
    events.push(
      event(`sale:${id}`, "sale.completed", soldAt, ctx.receivedAt, defined({
        saleId: lightspeedRef("sale", id),
        customerId,
        channel,
        // An unreadable quantity or price stays as it is, so the sales schema dead-letters the sale with its raw record.
        lines: sold.map((l) => ({ sku: l.sku, quantity: l.quantity, unitPriceCents: l.priceCents, discountCents: l.discountCents ?? 0 })),
        totalCents,
        payments: payments.length ? payments : [{ method: "other", amountCents: totalCents }],
      })),
    );
  }
  if (returned.length) {
    const ret = record(sale.return);
    // A return not linked to a sale is recorded against itself.
    const original = lightspeedId(ret.original_sale_id) ?? id;
    events.push(
      event(`return:${id}`, "sale.returned", soldAt, ctx.receivedAt, {
        saleId: lightspeedRef("sale", original),
        returnId: lightspeedRef("return", id),
        lines: returned.map((l) => ({ sku: l.sku, quantity: -l.quantity!, refundCents: l.totalCents === null ? null : Math.abs(l.totalCents) })),
      }),
    );
  }
  return events;
}

/** A product with its one variant, in the Shopify connector's product.updated shape. */
export function lightspeedProductEvent(product: LightspeedRecord, ctx: LightspeedContext): LightspeedBrainEvent | null {
  const id = lightspeedId(product?.id);
  if (!id) return null;
  const updatedAt = lightspeedTime(product.updated_at);
  const active = record(product.active);
  const status = lightspeedTime(product.deleted_at) ? "DELETED" : active.in_store === false && active.ecwid !== true ? "ARCHIVED" : "ACTIVE";
  const version = lightspeedVersion(product);
  return event(`product:${id}:${version ?? updatedAt ?? "unknown"}:${status}`, "product.updated", updatedAt, ctx.receivedAt, {
    productId: lightspeedRef("product", id),
    title: text(product.variant_name) ?? `Lightspeed product ${id.slice(0, 8)}`,
    status,
    vendor: null,
    productType: null,
    tags: [],
    // Counts come from the inventory list, per outlet.
    variants: [{ variantId: lightspeedRef("product", id), sku: text(product.sku, 100) ?? lightspeedProductSku(id), priceCents: lightspeedCents(record(product.prices).price_excluding_tax), inventoryQuantity: null }],
  });
}

/**
 * What an outlet has of a product, in the POS connectors' inventory.counted
 * shape. Lightspeed's inventory records carry no time, so the count is
 * dated when it was read.
 */
export function lightspeedInventoryEvent(item: LightspeedRecord, ctx: LightspeedContext): LightspeedBrainEvent | null {
  const product = lightspeedId(item?.product_id);
  const outlet = lightspeedId(item?.outlet_id);
  if (!product || !outlet || lightspeedTime(item.deleted_at)) return null;
  const version = lightspeedVersion(item);
  return event(`count:${product}:${outlet}:${version ?? ctx.receivedAt}`, "inventory.counted", ctx.receivedAt, ctx.receivedAt, {
    sku: ctx.sku(product),
    // A fractional or negative level is kept as Lightspeed reports it (or null), so the inventory schema dead-letters it.
    onHand: lightspeedQuantity(item.current_inventory_level),
    variantId: lightspeedRef("product", product),
    locationId: lightspeedRef("outlet", outlet),
  });
}

/**
 * A customer profile under its keyed reference. The name the departments
 * see is a label made from the reference, never the customer's own.
 * Lightspeed's do_not_email only says a customer opted out, not that they
 * agreed to email, so consent is never assumed.
 */
export function lightspeedCustomerEvent(customer: LightspeedRecord, ctx: LightspeedContext): LightspeedBrainEvent | null {
  const ref = ctx.customerRef(customer?.id);
  if (!ref || lightspeedTime(customer.deleted_at)) return null;
  const updatedAt = lightspeedTime(customer.updated_at);
  const mac = ref.slice(ref.lastIndexOf(":") + 1);
  const version = lightspeedVersion(customer);
  return event(`customer:${mac}:${version ?? updatedAt ?? "unknown"}`, "customer.profile_updated", updatedAt, ctx.receivedAt, {
    customerId: ref,
    name: `Lightspeed customer ${mac.slice(0, 8)}`,
    marketingConsent: false,
  });
}
