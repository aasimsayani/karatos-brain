import { createHash } from "node:crypto";

/**
 * Turns Wix records into Brain A events, in the same types and shapes as the
 * Shopify, Square, Clover, WooCommerce and BigCommerce connectors, so a Wix
 * sale reads like any other:
 *
 * - eCommerce orders: order.updated (Shopify's shape), sale.completed once
 *   paid (the sales department's schema), and sale.returned for each unit
 *   the order says was refunded;
 * - products, Catalog V3 (with their read-only variants) or Catalog V1 (with
 *   their variants and stock): product.updated (Shopify's shape), and for V1
 *   inventory.counted (the POS connector's shape) per tracked variant;
 * - Catalog V3 inventory items: inventory.counted per tracked item;
 * - contacts: customer.profile_updated, under a keyed reference.
 *
 * Only what the departments use is kept. No names, email addresses, phone
 * numbers, billing, shipping or recipient addresses, buyer notes, custom
 * fields, activities or tags.
 */

export type WixRecord = Record<string, unknown>;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface WixBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** What normalizing needs from the connector: keyed customer references. */
export interface WixContext {
  receivedAt: string;
  customerRef(id: unknown): string | undefined;
}

/** Wix IDs: GUIDs, and a few other short identifiers. Undefined for anything else. */
const ID = /^[A-Za-z0-9-]{1,64}$/;
export function wixId(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 && ID.test(value) ? value : undefined;
}

const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 time Wix wrote (to the microsecond, with a zone), as ISO 8601 UTC to the millisecond. Undefined when unreadable. */
export function wixTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return undefined;
  const match = TIME.exec(value);
  if (!match) return undefined;
  const ms = Date.parse(`${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}${match[3]}`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** "125.50" (or 125.5) → 12550, without floating point, rounding past the cent. Null for anything that isn't a plain amount. */
export function wixCents(amount: unknown): number | null {
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
export function wixQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
/** Wix's enum values: statuses, channels, product types. */
const enumOf = (value: unknown, max = 40) => (typeof value === "string" && value.length <= max && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : undefined);
const list = (value: unknown): WixRecord[] => (Array.isArray(value) ? value.filter((v): v is WixRecord => v !== null && typeof v === "object" && !Array.isArray(v)) : []);
const obj = (value: unknown): WixRecord => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as WixRecord) : {});
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const currencyOf = (value: unknown) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined);
const amountOf = (price: unknown) => wixCents(obj(price).amount);
/** The time as Wix wrote it, cut short, for keys; "unknown" when missing. */
const rawTime = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 40) : "unknown");
const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export const wixRef = (kind: string, id: string) => `wix:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): WixBrainEvent {
  // A record missing its timestamp gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `wix_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `wix:${key}`, payload };
}

/** Payment statuses at which the money has been taken. Wix orders carry no payment method, so sales say "other". */
const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "FULLY_REFUNDED"]);
/** Wix point of sale counts as the store; every other channel (web, marketplaces, invoices) as online. */
const channelOf = (order: WixRecord): "store" | "online" => (enumOf(obj(order.channelInfo).type) === "POS" ? "store" : "online");
/** The most refunded units of one line turned into sale.returned events, so a hostile count can't flood the pipeline. */
const MAX_RETURN_UNITS = 500;

/** A line's SKU, or a stable stand-in for items sold without one, as Shopify's connector uses shopify-variant-<id>. */
function lineSku(orderId: string, line: WixRecord): string {
  const sku = text(obj(line.physicalProperties).sku, 100);
  if (sku) return sku;
  const reference = obj(line.catalogReference);
  const variant = wixId(obj(reference.options).variantId);
  if (variant) return `wix-variant-${variant}`;
  const item = wixId(reference.catalogItemId);
  if (item) return `wix-product-${item}`;
  return `wix-line-${orderId}-${wixId(line.id) ?? "0"}`;
}

/**
 * An order's events: its latest state, the sale once paid, and a return for
 * each refunded unit. Wix records refunds on the order as each line's
 * running `refundQuantity`, without dates, so each refunded unit is its own
 * sale.returned, keyed by order, line and unit: a later refund adds only the
 * new units, and a replay adds nothing. Its time is the order's last change
 * when the refund was first read.
 */
export function wixOrderEvents(order: WixRecord, ctx: WixContext): WixBrainEvent[] {
  const id = wixId(order?.id);
  if (!id) return [];
  const updated = wixTime(order.updatedDate);
  const status = enumOf(order.status);
  const paymentStatus = enumOf(order.paymentStatus);
  const summary = obj(order.priceSummary);
  const totalCents = amountOf(summary.total);
  const currency = currencyOf(order.currency);
  const channel = channelOf(order);
  const customerId = ctx.customerRef(obj(order.buyerInfo).contactId);
  const lines = list(order.lineItems);
  const number = typeof order.number === "string" || typeof order.number === "number" ? String(order.number).slice(0, 20) : undefined;
  const events: WixBrainEvent[] = [
    event(`order:${id}:${rawTime(order.updatedDate)}`, "order.updated", updated, ctx.receivedAt, defined({
      orderId: wixRef("order", id),
      name: number && /^\d{1,20}$/.test(number) ? `#${number}` : null,
      createdAt: wixTime(order.purchasedDate) ?? wixTime(order.createdDate) ?? null,
      status: status ?? null,
      financialStatus: paymentStatus ?? null,
      fulfillmentStatus: enumOf(order.fulfillmentStatus) ?? null,
      cancelledAt: status === "CANCELED" ? updated ?? null : null,
      channel,
      currency: currency ?? null,
      totalCents,
      lineCount: lines.length,
      // Wix returns every line of an order.
      linesComplete: true,
      customerId,
    })),
  ];

  const saleLines = lines.map((l) => {
    const quantity = wixQuantity(l.quantity);
    return {
      sku: lineSku(id, l),
      quantity,
      unitPriceCents: amountOf(l.priceBeforeDiscounts) ?? amountOf(l.price),
      discountCents: amountOf(l.totalDiscount) ?? 0,
    };
  });
  const readable = saleLines.every((l) => l.quantity !== null && l.quantity > 0 && l.unitPriceCents !== null && l.unitPriceCents >= 0 && l.discountCents >= 0);
  const paid = PAID.has(paymentStatus ?? "") && status !== "REJECTED" && status !== "INITIALIZED";
  // Keyed by order, not by update, so later edits never count the sale twice.
  if (paid && totalCents !== null && totalCents > 0 && saleLines.length && readable) {
    events.push(
      event(`sale:${id}`, "sale.completed", wixTime(order.purchasedDate) ?? wixTime(order.createdDate), ctx.receivedAt, defined({
        saleId: wixRef("order", id),
        customerId,
        channel,
        lines: saleLines,
        totalCents,
        payments: [{ method: "other", amountCents: totalCents }],
      })),
    );
  }

  for (const line of lines) {
    const lineId = wixId(line.id);
    const quantity = wixQuantity(line.quantity);
    const refunded = wixQuantity(line.refundQuantity);
    if (!lineId || !quantity || quantity <= 0 || !refunded || refunded <= 0) continue;
    const units = Math.min(refunded, quantity, MAX_RETURN_UNITS);
    const lineTotal = amountOf(line.totalPriceAfterTax);
    const unitCents = lineTotal !== null && lineTotal >= 0 ? Math.round(lineTotal / quantity) : null;
    const sku = lineSku(id, line);
    for (let unit = 1; unit <= units; unit++) {
      events.push(
        event(`return:${id}:${lineId}:${unit}`, "sale.returned", updated, ctx.receivedAt, {
          saleId: wixRef("order", id),
          returnId: wixRef("return", `${id}:${lineId}:${unit}`),
          // Null when the line's total can't be read, so the sales schema dead-letters it.
          lines: [{ sku, quantity: 1, refundCents: unitCents }],
        }),
      );
    }
  }
  return events;
}

interface Variant {
  variantId: string;
  sku: string;
  priceCents: number | null;
  inventoryQuantity: number | null;
}

function productEvent(id: string, rawUpdated: unknown, payload: Omit<Record<string, unknown>, "variants"> & { variants: Variant[] }, receivedAt: string): WixBrainEvent {
  // A variant can change without its product's date moving, so the variants are part of the key.
  return event(`product:${id}:${rawTime(rawUpdated)}:${short(JSON.stringify(payload.variants))}`, "product.updated", wixTime(rawUpdated), receivedAt, payload);
}

/**
 * A Catalog V3 product with its read-only variants: product.updated in
 * Shopify's shape. V3 keeps stock on inventory items, so the variants carry
 * no count; the inventory stream sends those.
 */
export function wixProductV3Events(product: WixRecord, variants: WixRecord[], ctx: WixContext): WixBrainEvent[] {
  const id = wixId(product?.id);
  if (!id) return [];
  const mine = variants.filter((v) => obj(v.productData).productId === id);
  const shaped: Variant[] = mine.flatMap((v) => {
    const variantId = wixId(v.variantId) ?? wixId(v.id);
    if (!variantId) return [];
    return [{ variantId: wixRef("variant", `${id}:${variantId}`), sku: text(v.sku, 100) ?? `wix-variant-${variantId}`, priceCents: amountOf(obj(v.price).actualPrice), inventoryQuantity: null }];
  });
  const type = enumOf(product.productType);
  return [
    productEvent(id, product.updatedDate, {
      productId: wixRef("product", id),
      title: text(product.name) ?? `Wix product ${id.slice(0, 8)}`,
      status: product.visible === false ? "hidden" : "visible",
      vendor: text(obj(product.brand).name, 60) ?? null,
      productType: type ? type.toLowerCase() : null,
      tags: [],
      variants: shaped,
    }, ctx.receivedAt),
  ];
}

/** A Catalog V3 inventory item (one variant at one location): a stock count when Wix tracks its quantity. */
export function wixInventoryItemEvents(item: WixRecord, ctx: WixContext): WixBrainEvent[] {
  const id = wixId(item?.id);
  const variantId = wixId(item?.variantId);
  const productId = wixId(item?.productId);
  if (!id || !variantId || !productId || item.trackQuantity !== true) return [];
  const onHand = wixQuantity(item.quantity);
  return [
    event(`count:${id}:${rawTime(item.updatedDate)}:${onHand ?? "unknown"}`, "inventory.counted", wixTime(item.updatedDate), ctx.receivedAt, defined({
      sku: text(obj(item.product).variantSku, 100) ?? `wix-variant-${variantId}`,
      // A negative count (sold before restock) or a missing one is kept as Wix reports it, so the inventory schema dead-letters it.
      onHand,
      variantId: wixRef("variant", `${productId}:${variantId}`),
      productId: wixRef("product", productId),
      locationId: wixId(item.locationId) ? wixRef("location", wixId(item.locationId)!) : undefined,
    })),
  ];
}

/**
 * A Catalog V1 product with its variants (read with includeVariants):
 * product.updated in Shopify's shape, and a stock count for each variant
 * whose quantity Wix tracks.
 */
export function wixProductV1Events(product: WixRecord, ctx: WixContext): WixBrainEvent[] {
  const id = wixId(product?.id);
  if (!id) return [];
  const stock = obj(product.stock);
  const raw = list(product.variants);
  // A product without managed variants still comes back with one default variant; without any, the product stands in.
  const units = raw.length
    ? raw.flatMap((v) => {
        const variantId = wixId(v.id);
        if (!variantId) return [];
        const data = obj(v.variant);
        const vs = obj(v.stock);
        return [{ variantId, sku: text(data.sku, 100) ?? text(product.sku, 100), price: obj(data.priceData).price, tracked: vs.trackQuantity === true, quantity: vs.quantity }];
      })
    : [{ variantId: id, sku: text(product.sku, 100), price: obj(product.priceData).price, tracked: stock.trackInventory === true, quantity: stock.quantity }];
  const variants: Variant[] = units.map((u) => ({
    variantId: wixRef("variant", `${id}:${u.variantId}`),
    sku: u.sku ?? `wix-variant-${u.variantId}`,
    priceCents: wixCents(u.price),
    inventoryQuantity: u.tracked ? wixQuantity(u.quantity) : null,
  }));
  const type = typeof product.productType === "string" && /^[a-z_]{1,40}$/.test(product.productType) ? product.productType : null;
  const events = [
    productEvent(id, product.lastUpdated, {
      productId: wixRef("product", id),
      title: text(product.name) ?? `Wix product ${id.slice(0, 8)}`,
      status: product.visible === false ? "hidden" : "visible",
      vendor: text(product.brand, 60) ?? null,
      productType: type,
      tags: [],
      variants,
    }, ctx.receivedAt),
  ];
  const at = wixTime(product.lastUpdated);
  units.forEach((u, i) => {
    if (!u.tracked) return;
    const onHand = wixQuantity(u.quantity);
    events.push(
      event(`count:${id}:${u.variantId}:${rawTime(product.lastUpdated)}:${onHand ?? "unknown"}`, "inventory.counted", at, ctx.receivedAt, {
        sku: variants[i]!.sku,
        onHand,
        variantId: variants[i]!.variantId,
        productId: wixRef("product", id),
      }),
    );
  });
  return events;
}

/**
 * A contact as a profile under its keyed reference. The name the departments
 * see is a label made from the reference, never the contact's own. Consent
 * is the main email's marketing subscription, and only SUBSCRIBED counts.
 */
export function wixContactEvent(contact: WixRecord, ctx: WixContext): WixBrainEvent | null {
  const ref = ctx.customerRef(contact?.id);
  if (!ref) return null;
  const at = wixTime(contact.updatedDate) ?? wixTime(contact.createdDate);
  const mac = ref.slice(ref.lastIndexOf(":") + 1);
  const consent = enumOf(obj(obj(contact.email).subscriptionStatus).status) === "SUBSCRIBED";
  return event(`customer:${mac}:${at ?? "unknown"}:${consent ? 1 : 0}`, "customer.profile_updated", at, ctx.receivedAt, {
    customerId: ref,
    name: `Wix customer ${mac.slice(0, 8)}`,
    marketingConsent: consent,
  });
}
