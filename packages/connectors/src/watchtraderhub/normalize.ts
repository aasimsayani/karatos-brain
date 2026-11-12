import { createHash } from "node:crypto";

/**
 * WatchTraderHub listings, parts and orders as Brain A events, in the types
 * and shapes the Etsy, Whatnot and POS connectors give, so a dealer's watches
 * read like any other stock:
 *
 * - product.updated for each watch listing (productType "watch", the brand as
 *   vendor) and each spare part (productType "part"), with one variant
 *   holding its SKU and price;
 * - inventory.counted for each listing's and part's stock;
 * - order.updated for each order reported to WatchTraderHub through the
 *   custom integration: its status, totals and line count.
 *
 * Orders give no sale.completed. WatchTraderHub's orders are the ones the
 * dealer's own site reports to it, so the sale belongs to that site's
 * connector, and counting it here too would count it twice.
 *
 * Only what the departments use is kept: no buyer name, email, phone or
 * address (nor the buyer's country), no descriptions, photos, labels or
 * business addresses.
 *
 * WatchTraderHub writes money as an integer amount with an ISO 4217 currency
 * alongside; the quickstart shows 1200000 as "$12,000.00", so the amount is
 * taken as minor units (cents). A record that doesn't read is dead-lettered
 * listing what was wrong, never guessed.
 */

export interface WatchTraderHubEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type WatchTraderHubRead = { ok: boolean; event: WatchTraderHubEvent };

const SYSTEM = "WatchTraderHub";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** The most cents an amount may hold: ten trillion dollars, far past any watch. */
const MAX_CENTS = 1e15;

/**
 * Listing statuses. The docs show active, and listing.sold says a listing
 * becomes sold and listing.in_stock that it returns to active stock. A sold
 * watch stays an active product with none on hand, as Etsy's sold-out
 * listings do.
 */
const LISTING_STATUSES = new Set(["active", "sold"]);
/** Part statuses: part.sold_out says a sold-out part reads sold_out; active is taken as the other. */
const PART_STATUSES = new Set(["active", "sold_out"]);
/** Order statuses the event catalog names: pending (not yet matched), matched (fulfilled) and dismissed (the dealer cancelled it). */
const ORDER_STATUSES = new Map<string, string>([
  ["pending", "PENDING"],
  ["matched", "MATCHED"],
  ["dismissed", "DISMISSED"],
]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

export const watchTraderHubRef = (kind: string, id: string) => `watchtraderhub:${kind}:${id}`;

/** An id WatchTraderHub gave (its examples are UUIDs), or undefined. */
export function watchTraderHubId(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/** An ISO 8601 time with a zone, as an ISO time, or undefined. */
export function watchTraderHubTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** An integer amount in minor units, from 0, or undefined. */
export function watchTraderHubCents(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_CENTS ? (value as number) : undefined;
}

/** A currency code, or undefined. */
export function watchTraderHubCurrency(value: unknown): string | undefined {
  return typeof value === "string" && CURRENCY.test(value) ? value : undefined;
}

/** A price object {amount, currency} as cents and its currency, or undefined when either doesn't read. */
export function watchTraderHubPrice(value: unknown): { cents: number; currency: string } | undefined {
  const p = obj(value);
  const cents = watchTraderHubCents(p.amount);
  const currency = watchTraderHubCurrency(p.currency);
  return cents === undefined || currency === undefined ? undefined : { cents, currency };
}

/** A stock count: a whole number from 0, or undefined. */
export function watchTraderHubQuantity(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/** The dealer's stock number, or a stable stand-in from the record's id. */
export function watchTraderHubSku(stockNumber: unknown, kind: "listing" | "part", id: string): string {
  return text(stockNumber, 100) ?? `watchtraderhub-${kind}-${id}`;
}

function read(kind: string, type: string, raw: unknown, problems: string[], key: string, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): WatchTraderHubRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `watchtraderhub:${kind}:${key}` : `watchtraderhub:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? occurredAt : undefined,
      receivedAt,
      idempotencyKey,
      payload: ok ? payload : { system: SYSTEM, kind, problems },
    },
  };
}

interface Stock {
  kind: "listing" | "part";
  raw: unknown;
  problems: string[];
  id: string | undefined;
  title: string;
  vendor: string | null;
  productType: string;
  sku: string;
  priceCents: number | null;
  onHand: number | undefined;
  /** Why the count doesn't read, when it doesn't. */
  countProblem: string | undefined;
  locationId: string | undefined;
  at: string | undefined;
}

/** A listing or part as product.updated with its one variant, then its stock as inventory.counted. */
function stockEvents(s: Stock, receivedAt: string): WatchTraderHubRead[] {
  const variantId = watchTraderHubRef(s.kind, s.id ?? "");
  const payload = {
    productId: variantId,
    title: s.title,
    status: "ACTIVE",
    vendor: s.vendor,
    productType: s.productType,
    tags: [],
    variants: [{ variantId, sku: s.sku, priceCents: s.priceCents, inventoryQuantity: s.onHand ?? null }],
  };
  const product = read(s.kind, "product.updated", s.raw, s.problems, `${s.id}:${digest(payload)}`, payload, s.at ?? receivedAt, receivedAt);
  if (!product.ok) return [product];
  const count = read(
    `${s.kind}_count`,
    "inventory.counted",
    s.raw,
    s.countProblem ? [s.countProblem] : [],
    `${s.id}:${s.onHand}:${s.at ?? "unknown"}`,
    defined({ sku: s.sku, onHand: s.onHand, variantId, locationId: s.locationId }),
    s.at ?? receivedAt,
    receivedAt,
  );
  return [product, count];
}

/** The common fields of a listing or part: id, status, price, location and time. */
function common(raw: unknown, kind: "listing" | "part", statuses: Set<string>) {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push(`${kind} is not an object`);
  const id = watchTraderHubId(r.id);
  if (!id) problems.push(`${kind} has no id that reads`);
  const status = statuses.has(r.status as string) ? (r.status as string) : undefined;
  if (!status) problems.push(`${kind} has no status that reads`);
  const location = watchTraderHubId(obj(r.store_location).id);
  return {
    r,
    problems,
    id,
    status,
    priceCents: watchTraderHubPrice(r.price)?.cents ?? null,
    locationId: location && watchTraderHubRef("location", location),
    at: watchTraderHubTime(r.updated_at) ?? watchTraderHubTime(r.created_at),
  };
}

/**
 * A watch listing as product.updated and inventory.counted. A sold listing
 * has none on hand; an active one has its quantity, and a count that doesn't
 * read is dead-lettered on its own.
 */
export function watchTraderHubListingEvents(raw: unknown, receivedAt: string): WatchTraderHubRead[] {
  const c = common(raw, "listing", LISTING_STATUSES);
  const watch = obj(c.r.watch);
  const brand = text(watch.brand, 100);
  const named = [brand, text(watch.model, 100), text(watch.reference, 100)].filter((v) => v !== undefined).join(" ");
  const quantity = watchTraderHubQuantity(c.r.quantity);
  const onHand = c.status === "sold" ? 0 : quantity;
  return stockEvents(
    {
      kind: "listing",
      raw,
      problems: c.problems,
      id: c.id,
      title: text(c.r.title) ?? (named || `WatchTraderHub listing ${c.id}`),
      vendor: brand ?? null,
      productType: "watch",
      sku: watchTraderHubSku(watch.stock_number, "listing", c.id ?? ""),
      priceCents: c.priceCents,
      onHand,
      countProblem: onHand === undefined ? "listing has no quantity that reads" : undefined,
      locationId: c.locationId,
      at: c.at,
    },
    receivedAt,
  );
}

/**
 * A spare part as product.updated and inventory.counted. A sold-out part has
 * none on hand; an active one has its quantity.
 */
export function watchTraderHubPartEvents(raw: unknown, receivedAt: string): WatchTraderHubRead[] {
  const c = common(raw, "part", PART_STATUSES);
  const part = obj(c.r.part);
  const quantity = watchTraderHubQuantity(c.r.quantity);
  const onHand = c.status === "sold_out" ? 0 : quantity;
  return stockEvents(
    {
      kind: "part",
      raw,
      problems: c.problems,
      id: c.id,
      title: text(part.name) ?? `WatchTraderHub part ${c.id}`,
      vendor: text(part.manufacturer, 100) ?? null,
      productType: "part",
      sku: watchTraderHubSku(part.stock_number, "part", c.id ?? ""),
      priceCents: c.priceCents,
      onHand,
      countProblem: onHand === undefined ? "part has no quantity that reads" : undefined,
      locationId: c.locationId,
      at: c.at,
    },
    receivedAt,
  );
}

/**
 * An order as order.updated: its status, totals in whole cents and its line
 * count, keyed by its id, status and a digest of what is kept, since orders
 * carry no updated_at. An order that doesn't read is dead-lettered.
 */
export function watchTraderHubOrderEvents(raw: unknown, receivedAt: string): WatchTraderHubRead[] {
  const o = obj(raw);
  const problems: string[] = [];
  if (o !== raw) problems.push("order is not an object");
  const id = watchTraderHubId(o.id);
  if (!id) problems.push("order has no id that reads");
  const rawStatus = ORDER_STATUSES.has(o.status as string) ? (o.status as string) : undefined;
  if (!rawStatus) problems.push("order has no status that reads");
  const currency = watchTraderHubCurrency(o.currency);
  if (!currency) problems.push("order has no currency that reads");
  const totalCents = watchTraderHubCents(o.total_amount);
  if (totalCents === undefined) problems.push("order has no total that reads");
  const orderedAt = watchTraderHubTime(o.ordered_at);
  const createdAt = watchTraderHubTime(o.created_at);
  if (!orderedAt && !createdAt) problems.push("order has no time that reads");
  const lines = Array.isArray(o.line_items) ? o.line_items : undefined;
  if (!lines) problems.push("order has no line items that read");
  const payload = defined({
    system: SYSTEM,
    orderId: watchTraderHubRef("order", id ?? ""),
    channelOrderId: text(o.channel_order_id, 100),
    createdAt: orderedAt ?? createdAt,
    status: rawStatus && ORDER_STATUSES.get(rawStatus),
    // Matched means matched to a listing and marked fulfilled; dismissed means the dealer cancelled it.
    shipped: rawStatus === "matched",
    cancelled: rawStatus === "dismissed",
    channel: "online",
    currency,
    shippingCents: watchTraderHubCents(o.shipping_amount),
    taxCents: watchTraderHubCents(o.tax_amount),
    discountCents: watchTraderHubCents(o.discount_amount),
    totalCents,
    lineCount: lines?.length,
  });
  return [read("order", "order.updated", raw, problems, `${id}:${rawStatus}:${digest(payload)}`, payload, orderedAt ?? createdAt, receivedAt)];
}
