/**
 * Turns Affirm's records into Brain A events, in the same neutral types the
 * Stripe connector emits: payment.charge_updated for each financed order
 * (Affirm's transaction), payment.refund_updated for each refund,
 * payment.dispute_updated for each dispute, and payout.updated for each
 * day's settlement, the money Affirm deposits in the merchant's bank.
 *
 * Only what the departments use is kept. Affirm's responses carry a signed
 * token that may hold encrypted personal data, and its events can carry the
 * shipping name, email, phone and address; none of that is kept, nor the
 * bank account's last four digits, nor anything from the checkout. The
 * merchant's own order id is kept, so a financed order can be matched to
 * the sale.
 *
 * Affirm sends money as whole cents already, with the currency alongside.
 * A transaction keeps its id as it moves from authorized to captured to
 * refunded, so the key is the id, the status and the amount refunded: each
 * step is stored once, and a replay is a duplicate.
 */

/** One transaction, as the transaction list and read return it. */
export interface AffirmTransaction {
  id?: string;
  status?: string;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  created?: string;
  order_id?: string;
  [field: string]: unknown;
}

/** One transaction event, as the transaction events list returns it. */
export interface AffirmTransactionEvent {
  id?: string;
  type?: string;
  amount?: number;
  fee?: number;
  fee_refunded?: number;
  currency?: string;
  created?: string;
  [field: string]: unknown;
}

/** One dispute, as Disputes API v3 lists it. */
export interface AffirmDispute {
  id?: string;
  transaction_id?: string;
  dispute_amount?: number;
  currency?: string;
  status?: string;
  dispute_reason?: string | null;
  created?: string;
  updated?: string | null;
  [field: string]: unknown;
}

/** One day's settlement summary. */
export interface AffirmSettlementSummary {
  deposit_id?: string;
  date?: string;
  total_sales?: number;
  total_refunds?: number;
  total_fees?: number;
  total_settled?: number;
  currency?: string;
  removal_state?: string;
  [field: string]: unknown;
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface AffirmBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

const ID = /^[A-Z0-9][A-Z0-9-]{3,39}$/;
/** Dispute and deposit ids are free-form in the docs (dispute_123, DEPOSIT-ARI-123). */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ORDER = /^[A-Za-z0-9._:#/-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const DAY = /^\d{4}-\d{2}-\d{2}/;
const WORD = /^[a-z_]{1,40}$/;

/** A table's own entry, never one inherited from Object (a status of "constructor" is just unknown). */
const own = <T>(table: Record<string, T>, key: unknown): T | undefined => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined);

export const affirmRef = (kind: string, id: string) => `affirm:${kind}:${id}`;
/** A transaction or event id. */
export const affirmId = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : undefined);
const nameOf = (value: unknown) => (typeof value === "string" && NAME.test(value) ? value : undefined);
const currencyOf = (value: unknown) => (typeof value === "string" && CURRENCY.test(value) ? value : null);
const wordOf = (value: unknown) => (typeof value === "string" && WORD.test(value) ? value : "unknown");

/** Whole cents. Null for anything that isn't a whole number. */
export function affirmCents(amount: unknown): number | null {
  if (typeof amount === "number") return Number.isSafeInteger(amount) ? amount : null;
  return typeof amount === "string" && /^-?\d{1,15}$/.test(amount.trim()) ? Number(amount) : null;
}

/** An RFC 3339 time, as an ISO time. Anything else is undefined, so the pipeline dead-letters the record rather than inventing a time. */
export function affirmTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value.trim())) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): AffirmBrainEvent {
  return { id: `affirm_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `affirm:${key}`, payload };
}

/** Transaction statuses in Stripe's three, keeping Affirm's own alongside. An authorization that expires becomes voided. */
const CHARGE: Record<string, "succeeded" | "pending" | "failed"> = {
  authorized: "pending",
  captured: "succeeded",
  partially_refunded: "succeeded",
  refunded: "succeeded",
  disputed: "succeeded",
  dispute_refunded: "succeeded",
  voided: "failed",
};
const CAPTURED = new Set(["captured", "partially_refunded", "refunded", "disputed", "dispute_refunded"]);
const DISPUTED = new Set(["disputed", "dispute_refunded"]);

/**
 * The event for one transaction. One with no usable id is dropped, since
 * there is nothing to key it by; one with no creation time has no occurredAt
 * and is dead-lettered.
 */
export function affirmTransactionEvents(t: AffirmTransaction, receivedAt: string): AffirmBrainEvent[] {
  if (!t || typeof t !== "object") return [];
  const id = affirmId(t.id);
  if (!id) return [];
  const status = wordOf(t.status);
  const amount = affirmCents(t.amount);
  const refunded = affirmCents(t.amount_refunded);
  const outcome = own(CHARGE, status) ?? "unknown";
  const order = typeof t.order_id === "string" && ORDER.test(t.order_id) ? t.order_id : undefined;
  return [
    event(`transaction:${id}:${status}:${refunded ?? 0}`, "payment.charge_updated", affirmTime(t.created), receivedAt, {
      chargeId: affirmRef("transaction", id),
      status: outcome,
      gatewayStatus: status,
      paid: outcome === "succeeded",
      captured: CAPTURED.has(status),
      voided: status === "voided",
      amountCents: amount,
      capturedCents: CAPTURED.has(status) ? amount : 0,
      refundedCents: refunded,
      currency: currencyOf(t.currency),
      disputed: DISPUTED.has(status),
      method: "financing",
      cardBrand: null,
      ...(order ? { orderId: order } : {}),
    }),
  ];
}

const REFUND: Record<string, string> = { refund: "succeeded", refund_voided: "canceled" };

/** Whether an event is a refund, or the voiding of one. */
export const affirmIsRefund = (type: unknown) => own(REFUND, type) !== undefined;

/**
 * A refund as Stripe writes one, linked to its transaction. Refunds never
 * change once made, so each is keyed by its event id; a voided refund is an
 * event of its own.
 */
export function affirmRefundEvents(transactionId: unknown, e: AffirmTransactionEvent, receivedAt: string): AffirmBrainEvent[] {
  if (!e || typeof e !== "object") return [];
  const id = affirmId(e.id);
  const status = own(REFUND, e.type);
  if (!id || !status) return [];
  const charge = affirmId(transactionId);
  return [
    event(`refund:${id}:${e.type}`, "payment.refund_updated", affirmTime(e.created), receivedAt, {
      refundId: affirmRef("event", id),
      ...(charge ? { chargeId: affirmRef("transaction", charge) } : {}),
      amountCents: affirmCents(e.amount),
      currency: currencyOf(e.currency),
      status,
      reason: null,
      feeRefundedCents: affirmCents(e.fee_refunded),
    }),
  ];
}

/** Affirm's dispute statuses in Stripe's words. */
const DISPUTE: Record<string, string> = {
  action_required_merchant: "needs_response",
  no_merchant_action_needed: "under_review",
  closed_merchant_favor: "won",
  closed_customer_favor: "lost",
  closed_customer_partial_favor: "lost",
};

/** A dispute, keyed by its id and status, so each step is stored once. */
export function affirmDisputeEvents(d: AffirmDispute, receivedAt: string): AffirmBrainEvent[] {
  if (!d || typeof d !== "object") return [];
  const id = nameOf(d.id);
  if (!id) return [];
  const status = wordOf(d.status);
  const charge = affirmId(d.transaction_id);
  return [
    event(`dispute:${id}:${status}`, "payment.dispute_updated", affirmTime(d.created), receivedAt, {
      disputeId: affirmRef("dispute", id),
      ...(charge ? { chargeId: affirmRef("transaction", charge) } : {}),
      amountCents: affirmCents(d.dispute_amount),
      currency: currencyOf(d.currency),
      reason: d.dispute_reason === null || d.dispute_reason === undefined ? null : wordOf(d.dispute_reason),
      status: own(DISPUTE, status) ?? "unknown",
      gatewayStatus: status,
    }),
  ];
}

/**
 * A day's settlement as a payout: what Affirm deposited, sales less refunds
 * and fees, under the deposit id the bank statement shows. A settlement
 * Affirm removed (failed or rejected) is keyed apart, so the change is seen.
 */
export function affirmSettlementEvents(s: AffirmSettlementSummary, receivedAt: string): AffirmBrainEvent[] {
  if (!s || typeof s !== "object") return [];
  const deposit = nameOf(s.deposit_id);
  const day = typeof s.date === "string" && DAY.test(s.date) && !Number.isNaN(Date.parse(s.date.slice(0, 10))) ? s.date.slice(0, 10) : undefined;
  if (!deposit) return [];
  const removed = s.removal_state === undefined || s.removal_state === null ? undefined : wordOf(s.removal_state);
  return [
    event(`settlement:${deposit}:${day ?? "unknown"}:${removed ?? "settled"}`, "payout.updated", day ? `${day}T00:00:00.000Z` : undefined, receivedAt, {
      payoutId: affirmRef("deposit", deposit),
      amountCents: affirmCents(s.total_settled),
      currency: currencyOf(s.currency),
      status: removed ? "failed" : "paid",
      method: "bank_transfer",
      type: "settlement",
      arrivalDate: null,
      settledOn: day ?? null,
      salesCents: affirmCents(s.total_sales),
      refundCents: affirmCents(s.total_refunds),
      feeCents: affirmCents(s.total_fees),
      ...(removed ? { removalState: removed } : {}),
    }),
  ];
}
