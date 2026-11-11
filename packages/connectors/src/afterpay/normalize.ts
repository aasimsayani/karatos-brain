import { createHash } from "node:crypto";

/**
 * Turns Afterpay payments into Brain A events, in the neutral types the
 * Stripe and Affirm connectors emit:
 *
 * - `payment.charge_updated` for each Afterpay order: its amount, how much
 *   was captured and refunded, its state (approved, captured, voided,
 *   expired and so on) and the store's own order number, so a pay-in-four
 *   sale can be matched to the sale in the POS;
 * - `payment.refund_updated` for each refund on it.
 *
 * Only what sales and finance use is kept. A payment's order details carry
 * the shopper's name, email, phone and addresses, and its token is the
 * checkout's; none of that is kept, nor the items.
 *
 * Afterpay writes money as a decimal string, "29.99", with the currency
 * alongside; it is kept as whole cents. A payment keeps its id as it moves
 * from approved to captured to refunded, so its key is the id, the state and
 * the amounts captured and refunded: each step is stored once, and a replay
 * is a duplicate. A row that doesn't read is dead-lettered listing what was
 * wrong.
 */

export interface AfterpayEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type AfterpayRead = { ok: boolean; event: AfterpayEvent };

const SYSTEM = "Afterpay";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The store's order number: Afterpay allows up to 85 characters. */
const ORDER = /^[A-Za-z0-9._:#/ -]{1,85}$/;
const CURRENCY = /^[A-Z]{3}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Afterpay's payment states in Stripe's three outcomes, keeping Afterpay's own alongside. */
const STATES = new Map<string, "succeeded" | "pending" | "failed">([
  ["AUTH_APPROVED", "pending"],
  ["PARTIALLY_CAPTURED", "succeeded"],
  ["CAPTURED", "succeeded"],
  ["AUTH_DECLINED", "failed"],
  ["CAPTURE_DECLINED", "failed"],
  ["VOIDED", "failed"],
  ["EXPIRED", "failed"],
  ["REVERSED", "failed"],
]);
const CAPTURED = new Set(["PARTIALLY_CAPTURED", "CAPTURED"]);

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const idOf = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : undefined);

/** An ISO 8601 time with a zone, as an ISO time, or undefined. */
export function afterpayTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A Money object as whole cents and its currency, or undefined when either doesn't read. */
export function afterpayMoney(value: unknown): { cents: number; currency: string } | undefined {
  const m = obj(value);
  if (typeof m.amount !== "string" || !AMOUNT.test(m.amount) || !CURRENCY.test(String(m.currency))) return undefined;
  const [whole, fraction = ""] = m.amount.split(".");
  return { cents: Number(whole) * 100 + Number(fraction.padEnd(2, "0")), currency: m.currency as string };
}

function read(kind: string, type: string, raw: unknown, problems: string[], key: string, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string): AfterpayRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? `afterpay:${kind}:${key}` : `afterpay:unreadable_${kind}:${short(raw)}`;
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

/** The events for one payment: the charge, then each refund on it, oldest first. */
export function afterpayPaymentEvents(raw: unknown, receivedAt: string): AfterpayRead[] {
  const p = obj(raw);
  const problems: string[] = [];
  if (p !== raw) problems.push("payment is not an object");
  const id = idOf(p.id);
  if (!id) problems.push("payment has no id that reads");
  const amount = afterpayMoney(p.originalAmount);
  if (!amount) problems.push("payment has no amount that reads");
  const created = afterpayTime(p.created);
  if (!created) problems.push("payment has no time that reads");
  const state = STATES.has(p.paymentState as string) ? (p.paymentState as string) : undefined;
  const declined = p.status === "DECLINED";
  if (!state && !declined) problems.push("payment has no state that reads");
  const open = afterpayMoney(p.openToCaptureAmount);
  const refunds = (Array.isArray(p.refunds) ? p.refunds : []).map((r) => refundOf(r, id, amount?.currency, receivedAt));
  const refunded = refunds.reduce((n, r) => n + ((r.event.payload.amountCents as number | undefined) ?? 0), 0);
  const captured = state && CAPTURED.has(state) && amount ? amount.cents - (open?.cents ?? 0) : 0;
  const outcome = declined ? "failed" : STATES.get(state ?? "") ?? "failed";
  const order = typeof p.merchantReference === "string" && ORDER.test(p.merchantReference) ? p.merchantReference : undefined;
  const gateway = declined ? "declined" : state?.toLowerCase();
  const charge = read(
    "payment",
    "payment.charge_updated",
    raw,
    problems,
    `${id}:${gateway}:${captured}:${refunded}`,
    {
      system: SYSTEM,
      chargeId: `afterpay:payment:${id}`,
      status: outcome,
      gatewayStatus: gateway,
      paid: outcome === "succeeded",
      captured: captured > 0,
      voided: state === "VOIDED",
      amountCents: amount?.cents,
      capturedCents: captured,
      refundedCents: refunded,
      currency: amount?.currency,
      method: "financing",
      cardBrand: null,
      ...(order ? { orderId: order } : {}),
    },
    created,
    receivedAt,
  );
  return [charge, ...(charge.ok ? refunds : [])];
}

function refundOf(raw: unknown, paymentId: string | undefined, currency: string | undefined, receivedAt: string): AfterpayRead {
  const r = obj(raw);
  const problems: string[] = [];
  if (r !== raw) problems.push("refund is not an object");
  const id = idOf(r.refundId);
  if (!id) problems.push("refund has no id that reads");
  const amount = afterpayMoney(r.amount);
  if (!amount) problems.push("refund has no amount that reads");
  else if (amount.currency !== currency) problems.push("refund is not in the payment's currency");
  const at = afterpayTime(r.refundedAt);
  if (!at) problems.push("refund has no time that reads");
  return read(
    "refund",
    "payment.refund_updated",
    raw,
    problems,
    `${id}`,
    { system: SYSTEM, refundId: `afterpay:refund:${id}`, chargeId: `afterpay:payment:${paymentId}`, amountCents: amount?.cents, currency: amount?.currency, status: "succeeded", reason: null },
    at,
    receivedAt,
  );
}
