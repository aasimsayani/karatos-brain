import { createHash } from "node:crypto";

/**
 * Extend's product protection contracts and orders as Brain A events:
 *
 * - `warranty.contract_updated` for each version of a protection plan
 *   contract: its status, plan, term, coverage dates and status, what the
 *   plan sold for, the order and transaction it was sold on, and the
 *   covered product's reference, name and price. No connector before this
 *   one read warranties or protection plans, so the type follows the
 *   `<domain>.<record>_updated` shape of `repair.ticket_updated` and
 *   `crm.deal_updated`.
 * - `order.updated` for each version of an order Extend holds for the
 *   store: its status, totals and line count, in the shape the Whatnot and
 *   Etsy connectors give. The store's own commerce system already reports
 *   the sale, so no `sale.completed` is made here, which would count it twice.
 *
 * Each is keyed by its record and a digest of what was kept, so reading one
 * again unchanged is a duplicate and any change is a new version.
 *
 * Only ids, amounts, dates, statuses and product references are kept: no
 * customer name, email, phone or address, no gift recipient, no refund
 * recipient, no terms or customer portal link, and no serial number. A
 * merchant customer ID is kept only when it reads as an ID, never as an
 * email. Money is in the currency's smallest unit, as Extend writes it. A
 * record that doesn't read is dead-lettered listing what was wrong, never
 * guessed.
 */

export interface ExtendEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type ExtendRead = { ok: boolean; event: ExtendEvent; updatedAt: string | undefined };

export const EXTEND_EVENTS = { contract: "warranty.contract_updated", order: "order.updated" } as const;

const SYSTEM = "Extend";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Ten digits are seconds and thirteen milliseconds: Extend's order example is the one, its contract and line item fields the other. */
const SECONDS = { min: 1e9, max: 1e10 };
const MILLISECONDS = { min: 1e12, max: 1e13 };

/** Contract statuses, as Extend's contract search lists them. */
const CONTRACT_STATUSES = new Set(["created", "live", "delivered", "expired", "fulfilled", "cancelled", "refund_requested", "refund_accepted", "refund_denied", "refund_paid", "voided", "pending_termination", "terminated"]);
/** Statuses where the plan still covers the product. */
const COVERING = new Set(["live", "delivered"]);
const COVERAGE_STATUSES = new Set(["covered_by_manufacturers_warranty", "covered_for_adh_only_by_extend", "covered_for_base_protection_only_by_extend", "covered_by_adh_and_base_protection_by_extend", "expired", "fulfilled", "cancelled"]);
const CANCELLATION_REASONS = new Set(["fraud_identified", "merchant_refund", "sp_claim", "correction_needed", "customer_requested", "merchant_requested", "created_in_error", "goodwill_escalation"]);
const PLAN_CATEGORIES = new Set(["service_contract", "shipping_contract"]);
const SERVICE_TYPES = new Set(["repair", "replace", "repair_depot", "repair_onsite", "repair_irobot"]);
/** Order statuses, as order.updated names them. */
const ORDER_STATUSES: ReadonlyMap<unknown, string> = new Map([
  ["pending", "PENDING"],
  ["open", "OPEN"],
  ["closed", "CLOSED"],
  ["canceled", "CANCELLED"],
  ["voided", "VOIDED"],
  ["refunded", "REFUNDED"],
  ["inactive", "INACTIVE"],
]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const known = (set: ReadonlySet<unknown>, value: unknown) => (set.has(value) ? (value as string) : undefined);

export const extendRef = (kind: string, id: string) => `extend:${kind}:${id}`;

/** An id Extend gave, or undefined. */
export function extendId(value: unknown): string | undefined {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/** An epoch time, in seconds (10 digits) or milliseconds (13 digits), as an ISO time, or undefined. */
export function extendTime(value: unknown): string | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  const n = value as number;
  if (n >= SECONDS.min && n < SECONDS.max) return new Date(n * 1000).toISOString();
  if (n >= MILLISECONDS.min && n < MILLISECONDS.max) return new Date(n).toISOString();
  return undefined;
}

/** An amount in the currency's smallest unit, a whole number of zero or more, or undefined. */
export function extendAmount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/** A whole number of months above zero, or undefined. */
function months(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function read(kind: string, type: string, raw: unknown, problems: string[], key: string, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): ExtendRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `extend:${kind}:${key}` : `extend:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    updatedAt: ok ? occurredAt : undefined,
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

/** One product protection contract as `warranty.contract_updated`, or a dead letter. */
export function extendContractEvent(raw: unknown, receivedAt: string): ExtendRead {
  const c = obj(raw);
  const problems: string[] = [];
  if (c !== raw) problems.push("contract is not an object");
  const id = extendId(c.id);
  if (!id) problems.push("contract has no id that reads");
  const status = known(CONTRACT_STATUSES, c.status);
  if (!status) problems.push("contract has no status that reads");
  const currency = typeof c.purchaseCurrency === "string" && CURRENCY.test(c.purchaseCurrency) ? c.purchaseCurrency : undefined;
  if (!currency) problems.push("contract has no currency that reads");
  const price = extendAmount(c.purchasePrice);
  if (price === undefined) problems.push("contract has no purchase price that reads");
  const createdAt = extendTime(c.createdAt);
  const updatedAt = extendTime(c.updatedAt) ?? createdAt;
  if (!updatedAt) problems.push("contract has no time that reads");
  const plan = obj(c.plan);
  const details = obj(c.planDetails);
  const coverage = obj(c.coverage);
  const product = obj(c.product);
  const orderId = extendId(c.orderId);
  const payload = defined({
    system: SYSTEM,
    contractId: extendRef("contract", id ?? ""),
    status,
    covering: status ? COVERING.has(status) : undefined,
    test: c.isTest === true,
    planId: text(plan.id, 100),
    planCategory: known(PLAN_CATEGORIES, plan.category),
    termMonths: months(details.term_length),
    serviceType: known(SERVICE_TYPES, details.service_type),
    coverageStatus: known(COVERAGE_STATUSES, coverage.status),
    coverageStartsAt: extendTime(coverage.starts),
    coverageEndsAt: extendTime(coverage.ends),
    coverageAmount: extendAmount(coverage.amount),
    coverageRemaining: extendAmount(coverage.amountRemaining),
    currency,
    purchasePrice: price,
    listPrice: extendAmount(c.listPrice),
    purchasedAt: extendTime(c.purchaseDate),
    createdAt,
    cancelledAt: extendTime(c.cancelledAt),
    refundedAt: extendTime(c.refundedAt),
    cancellationReason: known(CANCELLATION_REASONS, c.cancellationReason),
    orderId: orderId && extendRef("order", orderId),
    transactionId: text(c.transactionId, 100),
    customerId: extendId(c.merchantCustomerId),
    product: defined({
      referenceId: text(product.referenceId, 100),
      name: text(product.name),
      purchasePrice: extendAmount(product.purchasePrice),
      listPrice: extendAmount(product.listPrice),
      purchasedAt: extendTime(product.purchaseDate),
      fulfilledAt: extendTime(product.fulfillmentDate),
      warrantyMonthsParts: months(product.manufacturerWarrantyLengthParts),
      warrantyMonthsLabor: months(product.manufacturerWarrantyLengthLabor),
    }),
  });
  return read("contract", EXTEND_EVENTS.contract, raw, problems, `${id}:${digest(payload)}`, payload, updatedAt, receivedAt);
}

/** One order as `order.updated`, or a dead letter. */
export function extendOrderEvent(raw: unknown, receivedAt: string): ExtendRead {
  const o = obj(raw);
  const problems: string[] = [];
  if (o !== raw) problems.push("order is not an object");
  const id = extendId(o.id);
  if (!id) problems.push("order has no id that reads");
  const currency = typeof o.currency === "string" && CURRENCY.test(o.currency) ? o.currency : undefined;
  if (!currency) problems.push("order has no currency that reads");
  // Extend's docs don't mark the status as always there: one that is missing is left out, one that isn't Extend's is a problem.
  const status = ORDER_STATUSES.get(o.status);
  if (o.status !== undefined && o.status !== null && !status) problems.push("order has a status that doesn't read");
  const createdAt = extendTime(o.createdAt);
  const updatedAt = extendTime(o.updatedAt) ?? createdAt;
  if (!updatedAt) problems.push("order has no time that reads");
  const lines = Array.isArray(o.lineItems) ? o.lineItems : undefined;
  if (!lines) problems.push("order has no line items that read");
  const payload = defined({
    system: SYSTEM,
    orderId: extendRef("order", id ?? ""),
    createdAt,
    status,
    cancelled: status && (status === "CANCELLED" || status === "VOIDED"),
    refunded: status && status === "REFUNDED",
    refundedAt: extendTime(o.refundedAt),
    test: o.isTest === true,
    transactionId: text(o.transactionId, 100),
    customerId: extendId(o.merchantCustomerId),
    currency,
    subtotalCents: extendAmount(o.productCostTotal),
    shippingCents: extendAmount(o.shippingCostTotal),
    taxCents: extendAmount(o.taxCostTotal),
    shippingTaxCents: extendAmount(o.shippingTaxCostTotal),
    discountCents: extendAmount(o.discountAmountTotal),
    totalCents: extendAmount(o.total),
    lineCount: lines?.length,
  });
  return read("order", EXTEND_EVENTS.order, raw, problems, `${id}:${digest(payload)}`, payload, updatedAt, receivedAt);
}
