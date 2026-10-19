import { createHash } from "node:crypto";

/**
 * Turns Stripe objects into Brain A events. Stripe records money movement,
 * not what was sold, so its events keep Stripe's own shape under
 * Stripe-neutral types (payment.charge_updated, payment.refund_updated,
 * payment.dispute_updated, payout.updated, balance.transaction_recorded).
 * Customers become clienteling profiles. Only what the departments use is
 * kept: no email addresses, phone numbers, addresses, or card numbers.
 *
 * Amounts stay in Stripe's smallest currency unit (cents for USD), with the
 * currency alongside.
 */

export interface StripeCharge {
  id: string;
  object: "charge";
  amount: number;
  amount_captured: number;
  amount_refunded: number;
  currency: string;
  created: number;
  status: "succeeded" | "pending" | "failed";
  paid: boolean;
  captured: boolean;
  refunded: boolean;
  disputed: boolean;
  customer: string | null;
  balance_transaction: string | null;
  payment_intent?: string | null;
  payment_method_details?: { type: string; card?: { brand?: string } } | null;
}

export interface StripeRefund {
  id: string;
  object: "refund";
  amount: number;
  charge: string | null;
  currency: string;
  created: number;
  status: string | null;
  reason: string | null;
}

export interface StripeDispute {
  id: string;
  object: "dispute";
  amount: number;
  charge: string;
  currency: string;
  created: number;
  reason: string;
  status: string;
}

export interface StripePayout {
  id: string;
  object: "payout";
  amount: number;
  currency: string;
  created: number;
  arrival_date: number;
  status: string;
  method: string;
  type: string;
}

export interface StripeBalanceTransaction {
  id: string;
  object: "balance_transaction";
  amount: number;
  fee: number;
  net: number;
  currency: string;
  created: number;
  available_on: number;
  type: string;
  reporting_category: string;
  source: string | null;
}

export interface StripeCustomer {
  id: string;
  object: "customer";
  name: string | null;
  created: number;
  deleted?: boolean;
}

export type StripeObject = StripeCharge | StripeRefund | StripeDispute | StripePayout | StripeBalanceTransaction | StripeCustomer;

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface StripeBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Unix seconds to ISO 8601. Undefined for anything that isn't a positive whole number. */
export function fromUnix(seconds: unknown): string | undefined {
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

export const stripeRef = (kind: string, id: string) => `stripe:${kind}:${id}`;

/** Stripe payment method types mapped to the sales department's payment methods. */
export function stripePaymentMethod(type: string | undefined): string {
  if (!type) return "other";
  if (type === "card" || type === "card_present" || type === "interac_present" || type === "link") return "card";
  if (/^(affirm|klarna|afterpay_clearpay|zip)$/.test(type)) return "financing";
  return "other";
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): StripeBrainEvent {
  // A record missing its timestamp gets no occurredAt, so the pipeline dead-letters it with the raw record kept.
  return { id: `stripe_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `stripe:${key}`, payload };
}

/**
 * A charge's state. The key changes when the money does (captured, refunded,
 * disputed, status), so each change is stored once and replays are duplicates.
 */
export function chargeEvent(c: StripeCharge, receivedAt: string): StripeBrainEvent {
  const state = `${c.status}:${c.amount_captured}:${c.amount_refunded}:${c.disputed ? "disputed" : "clear"}`;
  return event(`charge:${c.id}:${state}`, "payment.charge_updated", fromUnix(c.created), receivedAt, {
    chargeId: stripeRef("charge", c.id),
    status: c.status,
    paid: c.paid,
    captured: c.captured,
    amountCents: c.amount,
    capturedCents: c.amount_captured,
    refundedCents: c.amount_refunded,
    currency: c.currency,
    disputed: c.disputed,
    method: stripePaymentMethod(c.payment_method_details?.type),
    cardBrand: c.payment_method_details?.card?.brand ?? null,
    ...(c.payment_intent ? { paymentIntentId: stripeRef("payment_intent", c.payment_intent) } : {}),
    ...(c.customer ? { customerId: stripeRef("customer", c.customer) } : {}),
    ...(c.balance_transaction ? { balanceTransactionId: stripeRef("balance_transaction", c.balance_transaction) } : {}),
  });
}

export function refundEvent(r: StripeRefund, receivedAt: string): StripeBrainEvent {
  return event(`refund:${r.id}:${r.status ?? "unknown"}`, "payment.refund_updated", fromUnix(r.created), receivedAt, {
    refundId: stripeRef("refund", r.id),
    ...(r.charge ? { chargeId: stripeRef("charge", r.charge) } : {}),
    amountCents: r.amount,
    currency: r.currency,
    status: r.status,
    reason: r.reason,
  });
}

export function disputeEvent(d: StripeDispute, receivedAt: string): StripeBrainEvent {
  return event(`dispute:${d.id}:${d.status}`, "payment.dispute_updated", fromUnix(d.created), receivedAt, {
    disputeId: stripeRef("dispute", d.id),
    chargeId: stripeRef("charge", d.charge),
    amountCents: d.amount,
    currency: d.currency,
    reason: d.reason,
    status: d.status,
  });
}

export function payoutEvent(p: StripePayout, receivedAt: string): StripeBrainEvent {
  return event(`payout:${p.id}:${p.status}`, "payout.updated", fromUnix(p.created), receivedAt, {
    payoutId: stripeRef("payout", p.id),
    amountCents: p.amount,
    currency: p.currency,
    status: p.status,
    method: p.method,
    type: p.type,
    arrivalDate: fromUnix(p.arrival_date)?.slice(0, 10) ?? null,
  });
}

/** Balance transactions never change once made, so each is keyed by id alone. */
export function balanceTransactionEvent(b: StripeBalanceTransaction, receivedAt: string): StripeBrainEvent {
  return event(`balance_transaction:${b.id}`, "balance.transaction_recorded", fromUnix(b.created), receivedAt, {
    balanceTransactionId: stripeRef("balance_transaction", b.id),
    type: b.type,
    reportingCategory: b.reporting_category,
    amountCents: b.amount,
    feeCents: b.fee,
    netCents: b.net,
    currency: b.currency,
    availableOn: fromUnix(b.available_on)?.slice(0, 10) ?? null,
    ...(b.source ? { sourceId: b.source } : {}),
  });
}

/**
 * Stripe customers have no updated timestamp, so the key carries a hash of
 * the name kept: a rename is a new event, the same record again is a duplicate.
 * Stripe holds no marketing consent, so it is never assumed.
 */
export function customerEvent(c: StripeCustomer, receivedAt: string): StripeBrainEvent | null {
  if (c.deleted) return null;
  const name = c.name?.trim() || `Stripe customer ${c.id}`;
  // A short hash, so the name itself never appears in keys or ids.
  const version = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return event(`customer:${c.id}:${version}`, "customer.profile_updated", fromUnix(c.created), receivedAt, {
    customerId: stripeRef("customer", c.id),
    name,
    marketingConsent: false,
  });
}

/** The events for one Stripe object of any kind the connector reads. Other kinds give none. */
export function stripeObjectEvents(object: { object?: string } | null | undefined, receivedAt: string): StripeBrainEvent[] {
  switch (object?.object) {
    case "charge":
      return [chargeEvent(object as StripeCharge, receivedAt)];
    case "refund":
      return [refundEvent(object as StripeRefund, receivedAt)];
    case "dispute":
      return [disputeEvent(object as StripeDispute, receivedAt)];
    case "payout":
      return [payoutEvent(object as StripePayout, receivedAt)];
    case "balance_transaction":
      return [balanceTransactionEvent(object as StripeBalanceTransaction, receivedAt)];
    case "customer": {
      const e = customerEvent(object as StripeCustomer, receivedAt);
      return e ? [e] : [];
    }
    default:
      return [];
  }
}
