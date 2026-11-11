import { createHash } from "node:crypto";

/**
 * Turns Klarna settlements into Brain A events, in the same neutral types
 * the Stripe and Affirm connectors emit, so finance can match what Klarna
 * deposited against the bank statement and the sales behind it.
 *
 * - Each payout becomes `payout.updated`: the amount Klarna settled, under
 *   the payment reference the bank statement shows, with the sales,
 *   returns, fees, commission, holdbacks and other totals that make it up.
 * - Each line of a payout becomes `balance.transaction_recorded`: a sale,
 *   return, fee, commission, reversal and so on, with the Klarna order and
 *   capture or refund it belongs to and the merchant's own order reference,
 *   so a line can be matched to the sale.
 *
 * Klarna sends money as whole minor units already, with the currency
 * alongside. A settlement line has no ID of its own, so each is keyed by
 * its payout, its place in the payout and a digest of what was kept:
 * reading one again unchanged is a duplicate.
 *
 * Only what finance uses is kept. Klarna's comment text, the shipping
 * country and the merchant's second reference are not kept. A record
 * without what it needs to be matched is dead-lettered listing what was
 * wrong.
 */

export interface KlarnaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const KLARNA_PAYOUT_EVENT = "payout.updated";
export const KLARNA_TRANSACTION_EVENT = "balance.transaction_recorded";

const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const WORD = /^[A-Z][A-Z0-9_]{0,59}$/;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})(?:T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/;
const SETTLEMENT_TYPES = new Set(["GROSS", "NET", "GROSS_FEE"]);
const TYPES = new Set(["COMMISSION", "SALE", "REVERSAL", "RETURN", "TAX", "FEE", "FEE_REFUND", "CORRECTION", "REVERSAL_MERCHANT_PROTECTION", "CHARGE", "CREDIT", "HOLDBACK", "RELEASE"]);
/** The payout totals kept, by the name they are kept under. */
const TOTALS = {
  salesCents: "sale_amount",
  refundCents: "return_amount",
  feeCents: "fee_amount",
  feeRefundCents: "fee_refund_amount",
  commissionCents: "commission_amount",
  reversalCents: "reversal_amount",
  holdbackCents: "holdback_amount",
  releaseCents: "release_amount",
  chargeCents: "charge_amount",
  creditCents: "credit_amount",
  repayCents: "repay_amount",
  taxCents: "tax_amount",
  taxRefundCents: "tax_refund_amount",
  depositCents: "deposit_amount",
  openingDebtCents: "opening_debt_balance_amount",
  closingDebtCents: "closing_debt_balance_amount",
} as const;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// An array reads as a record without the fields asked for.
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max = 100): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const ref = (v: unknown): string | undefined => (typeof v === "string" && REFERENCE.test(v) ? v : undefined);
const minor = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
const word = (v: unknown, known?: Set<string>): string | null => (typeof v === "string" && WORD.test(v) && (!known || known.has(v)) ? v.toLowerCase() : null);

export const klarnaPayoutRef = (paymentReference: string) => `klarna:payout:${paymentReference}`;
export const klarnaOrderRef = (orderId: string) => `klarna:order:${orderId}`;

/** A time or day as Klarna writes it, as a UTC ISO time, or undefined. One without a zone is read as UTC. */
export function klarnaTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}${m[3] ?? ""}${m[4] ?? "Z"}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

export interface KlarnaContext {
  receivedAt: string;
}

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): KlarnaEvent {
  return { id: key.replace(/:/g, "_"), type, occurredAt, receivedAt, idempotencyKey: key, payload };
}

/** The payment reference of a payout, or undefined. */
export const klarnaPaymentReference = (raw: unknown): string | undefined => ref(record(raw).payment_reference);

/** The event for one payout. One that doesn't read is dead-lettered with its problems. */
export function klarnaPayoutEvent(raw: unknown, ctx: KlarnaContext): KlarnaEvent {
  const r = record(raw);
  const totals = record(r.totals);
  const problems: string[] = [];
  const reference = klarnaPaymentReference(r);
  if (!reference) problems.push("payout has no payment reference that reads");
  const at = klarnaTime(r.payout_date);
  if (!at) problems.push("payout has no payout date that reads");
  const amount = minor(totals.settlement_amount);
  if (amount === null) problems.push("payout has no settlement amount that reads");
  const currency = typeof r.currency_code === "string" && CURRENCY.test(r.currency_code) ? r.currency_code : undefined;
  if (!currency) problems.push("payout has no currency that reads");
  if (problems.length > 0) {
    const key = `klarna:unreadable_payout:${short(raw)}`;
    return event(key, KLARNA_PAYOUT_EVENT, undefined, ctx.receivedAt, { system: "Klarna", payoutId: reference ? klarnaPayoutRef(reference) : null, problems });
  }
  const payload: Record<string, unknown> = {
    system: "Klarna",
    payoutId: klarnaPayoutRef(reference!),
    amountCents: amount,
    currency,
    status: "paid",
    method: "bank_transfer",
    type: "settlement",
    arrivalDate: at!.slice(0, 10),
    settledOn: at!.slice(0, 10),
    settlementType: word(r.merchant_settlement_type, SETTLEMENT_TYPES),
  };
  for (const [name, field] of Object.entries(TOTALS)) payload[name] = minor(totals[field]);
  const key = `klarna:payout:${reference}:${short(payload)}`;
  return event(key, KLARNA_PAYOUT_EVENT, at, ctx.receivedAt, payload);
}

/** The event for one line of a payout. One that doesn't read is dead-lettered with its problems. */
export function klarnaTransactionEvent(raw: unknown, ctx: KlarnaContext & { paymentReference: string; line: number }): KlarnaEvent {
  const r = record(raw);
  const problems: string[] = [];
  const type = word(r.type, TYPES);
  if (!type) problems.push("transaction has no type that reads");
  const amount = minor(r.amount);
  if (amount === null) problems.push("transaction has no amount that reads");
  const currency = typeof r.currency_code === "string" && CURRENCY.test(r.currency_code) ? r.currency_code : undefined;
  if (!currency) problems.push("transaction has no currency that reads");
  const saleAt = klarnaTime(r.sale_date);
  const capturedAt = klarnaTime(r.capture_date);
  const at = capturedAt ?? saleAt;
  if (!at) problems.push("transaction has no date that reads");
  const order = ref(r.order_id);
  const payoutId = klarnaPayoutRef(ctx.paymentReference);
  if (problems.length > 0) {
    const key = `klarna:unreadable_transaction:${short(raw)}`;
    return event(key, KLARNA_TRANSACTION_EVENT, undefined, ctx.receivedAt, { system: "Klarna", payoutId, problems });
  }
  const payload: Record<string, unknown> = {
    system: "Klarna",
    payoutId,
    type,
    detailedType: word(r.detailed_type),
    amountCents: amount,
    currency,
    orderId: order ? klarnaOrderRef(order) : null,
    shortOrderId: ref(r.short_order_id) ?? null,
    captureId: ref(r.capture_id) ?? null,
    refundId: ref(r.refund_id) ?? null,
    merchantReference: text(r.merchant_reference1),
    vatAmountCents: minor(r.vat_amount),
    // Klarna writes a rate in hundredths of a percent: 2000 is 20%.
    vatRateBasisPoints: minor(r.vat_rate),
    purchaseCountry: typeof r.purchase_country === "string" && COUNTRY.test(r.purchase_country) ? r.purchase_country : null,
    paymentMethod: word(r.initial_payment_method_type),
    saleAt: saleAt ?? null,
    capturedAt: capturedAt ?? null,
  };
  // Two lines alike, such as two equal fees on one order, are told apart by where they sit in the payout, which doesn't change once paid.
  const key = `klarna:transaction:${ctx.paymentReference}:${ctx.line}:${short(payload)}`;
  return event(key, KLARNA_TRANSACTION_EVENT, at, ctx.receivedAt, payload);
}
