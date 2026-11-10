import { createHash, createHmac } from "node:crypto";

/**
 * Turns TaxJar records into Brain A events.
 *
 * - An order or refund transaction becomes `tax.transaction_updated`, the
 *   same event AvaTax transactions give: the sale or return, its amount,
 *   shipping and sales tax in cents, the state and country it was taxed
 *   in, and its lines by SKU and tax code. It is keyed by the transaction
 *   and a digest of what was kept, so reading it again is a duplicate and
 *   a change is a new event.
 * - The nexus regions become one `tax.nexus_updated` event listing where
 *   the business must collect tax, keyed the same way.
 *
 * A transaction can name the customer, so the event keeps the money and
 * the places and drops the person: the customer id becomes a keyed
 * reference; the ship-to street, city and ZIP code aren't kept, nor line
 * descriptions. The ship-from state, city and ZIP code are the store's own
 * and are kept, since sourcing rules tax by them.
 *
 * A transaction without an id, a day or amounts that read is
 * dead-lettered listing what was wrong.
 */

export interface TaxjarEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** The same type AvaTax transactions use, so finance reads both alike. */
export const TAXJAR_TRANSACTION_EVENT = "tax.transaction_updated";
export const TAXJAR_NEXUS_EVENT = "tax.nexus_updated";
const SYSTEM = "TaxJar";
/** Exemption types TaxJar documents. */
const EXEMPTIONS = new Set(["wholesale", "government", "marketplace", "other", "non_exempt"]);
const MAX_LINES = 200;
const MAX_REGIONS = 300;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const word = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);
const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z0-9]{1,3}$/;

/** Whole cents from a TaxJar amount in currency units, which it sends as a number or a numeric string. Null when it isn't one. */
export function taxjarCents(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d{1,6})?$/.test(value) ? Number(value) : NaN;
  return Math.abs(n) < 1e13 ? Math.round(Number((n * 100).toPrecision(15))) : null;
}

/** The YYYY-MM-DD day of a TaxJar transaction date ("2015-05-14T00:00:00Z", or a bare day), or null when it isn't a real day. */
export function taxjarDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() >= 1970 && t.toISOString().slice(0, 10) === day ? day : null;
}

/** A keyed reference for a TaxJar customer id, the same for every transaction of that customer. */
export function taxjarCustomerRef(key: string, customerId: unknown): string | undefined {
  if (typeof customerId !== "string" || customerId.trim() === "" || customerId.length > 255) return undefined;
  const mac = createHmac("sha256", key).update(`taxjar_customer:${customerId.trim()}`, "utf8").digest("hex");
  return `taxjar_customer:${mac.slice(0, 32)}`;
}

export interface TaxjarContext {
  customerKey: string;
  /** The provider the transaction was listed under. */
  provider: string;
  receivedAt: string;
}

export type TaxjarRead = { ok: boolean; event: TaxjarEvent };

function line(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  return {
    id: word(raw.id, /^[A-Za-z0-9_.:#-]{1,64}$/),
    sku: word(raw.product_identifier, /^[A-Za-z0-9_.:#/ -]{1,64}$/),
    taxCode: word(raw.product_tax_code, /^[0-9A-Za-z]{1,10}$/),
    quantity: Number.isFinite(raw.quantity) ? raw.quantity : null,
    unitPriceCents: taxjarCents(raw.unit_price),
    discountCents: taxjarCents(raw.discount),
    salesTaxCents: taxjarCents(raw.sales_tax),
  };
}

export function taxjarTransactionEvent(raw: unknown, kind: "orders" | "refunds", ctx: TaxjarContext): TaxjarRead {
  const problems: string[] = [];
  const t = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("transaction is not an object");
  const transactionId = typeof t.transaction_id === "string" && t.transaction_id.length > 0 && t.transaction_id.length <= 255 ? t.transaction_id : undefined;
  if (transactionId === undefined) problems.push("transaction has no id that reads");
  const day = taxjarDay(t.transaction_date);
  if (!day) problems.push("transaction has no day that reads");
  const amountCents = taxjarCents(t.amount);
  if (amountCents === null) problems.push("transaction has no amount that reads");
  const salesTaxCents = taxjarCents(t.sales_tax);
  if (salesTaxCents === null) problems.push("transaction has no sales tax that reads");

  const lines = (Array.isArray(t.line_items) ? t.line_items : []).slice(0, MAX_LINES).map(line).filter((l): l is Record<string, unknown> => l !== null);
  const exemption = typeof t.exemption_type === "string" && EXEMPTIONS.has(t.exemption_type) ? t.exemption_type : undefined;
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    transactionId,
    kind: kind === "orders" ? "sale" : "return",
    provider: word(t.provider, /^[a-z][a-z0-9_]{0,31}$/) ?? ctx.provider,
    // A refund names the order it refunds.
    referenceId: typeof t.transaction_reference_id === "string" && t.transaction_reference_id.length <= 255 ? t.transaction_reference_id : undefined,
    day,
    amountCents,
    shippingCents: taxjarCents(t.shipping),
    salesTaxCents,
    exemptReason: exemption && exemption !== "non_exempt" ? exemption : undefined,
    fromCountry: word(t.from_country, COUNTRY),
    fromRegion: word(t.from_state, REGION),
    fromCity: word(t.from_city, /^[\p{L}\p{N} .,'-]{1,60}$/u),
    fromZip: word(t.from_zip, /^[A-Za-z0-9 -]{3,10}$/),
    toCountry: word(t.to_country, COUNTRY),
    toRegion: word(t.to_state, REGION),
    customerRef: taxjarCustomerRef(ctx.customerKey, t.customer_id),
    lineCount: Array.isArray(t.line_items) ? t.line_items.length : 0,
    lines,
  };
  const ok = problems.length === 0;
  const key = ok ? `taxjar:${kind}:${payload.provider}:${transactionId}:${short(payload)}` : `taxjar:unreadable_transaction:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/[^A-Za-z0-9_-]/g, "_"),
      type: TAXJAR_TRANSACTION_EVENT,
      // TaxJar keeps no change time, so a transaction counts from its day. One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? `${day}T00:00:00.000Z` : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, transactionId: transactionId ?? null, problems },
    },
  };
}

/** The account's nexus regions as one event, keyed by what they are, so an unchanged list is a duplicate. */
export function taxjarNexusEvent(rows: unknown[], receivedAt: string): TaxjarEvent {
  const regions = rows
    .slice(0, MAX_REGIONS)
    .filter(isObject)
    .map((r) => ({ country: word(r.country_code, COUNTRY), region: word(r.region_code, REGION), name: word(r.region, /^[\p{L}\p{N} .,'()-]{1,60}$/u) }))
    .filter((r) => r.country !== undefined)
    .sort((a, b) => `${a.country}:${a.region ?? ""}`.localeCompare(`${b.country}:${b.region ?? ""}`));
  const key = `taxjar:nexus:${short(regions)}`;
  return {
    id: key.replace(/:/g, "_"),
    type: TAXJAR_NEXUS_EVENT,
    occurredAt: receivedAt,
    receivedAt,
    idempotencyKey: key,
    payload: { system: SYSTEM, regions },
  };
}
