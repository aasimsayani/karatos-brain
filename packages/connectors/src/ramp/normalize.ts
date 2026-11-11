import { createHash } from "node:crypto";

/**
 * Turns Ramp card transactions into Brain A events, so finance sees each
 * company card purchase with its category, receipt and approval state at
 * month-end. Each becomes `card.transaction_updated`, keyed by the
 * transaction and a digest of what was kept, so reading one again unchanged
 * is a duplicate, and a receipt, memo, category or settlement added later
 * is a new version.
 *
 * Only what finance uses is kept. A cardholder is kept as their Ramp user
 * ID, with their department and location, never their name. A memo or
 * receipt is kept as whether there is one, never its text or file. The
 * merchant's name, category code and Ramp's spend category are kept, and
 * the GL account a transaction is coded to.
 *
 * Amounts are whole cents, unsigned, with `direction` saying whether money
 * went out (a purchase) or came back (a refund). Ramp gives an amount two
 * ways: `entity_amount`, in minor units with a conversion rate, and the
 * older `amount`, in whole units of `currency_code`. The first is used when
 * it reads. A transaction without an ID, a time or an amount that reads is
 * dead-lettered listing what was wrong.
 */

export interface RampEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const RAMP_TRANSACTION_EVENT = "card.transaction_updated";

const ID = /^[A-Za-z0-9-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;
const STATES = new Set(["CLEARED", "COMPLETION", "PENDING", "PENDING_INITIATION", "DECLINED", "ERROR"]);
const MAX_MAJOR = 1e10;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// An array reads as a record without the fields asked for.
const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const id = (v: unknown): string | undefined => (typeof v === "string" && ID.test(v) ? v : undefined);

export const rampTransactionRef = (transactionId: string) => `ramp:transaction:${transactionId}`;
export const rampUserRef = (userId: string) => `ramp:user:${userId}`;

/** A time as Ramp writes it, as a UTC ISO time, or undefined. One without a zone is read as UTC. */
export function rampTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}${m[4] ?? "Z"}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** Signed whole cents from an amount object ({amount|value, currency_code|currency, minor_unit_conversion_rate}), or undefined. */
export function rampMinorAmount(v: unknown): { cents: number; currency: string } | undefined {
  const r = record(v);
  const minor = r.value ?? r.amount;
  const currency = r.currency ?? r.currency_code;
  // Ramp leaves the rate out for amounts in cents; one it sends as null is unknown.
  const rate = r.minor_unit_conversion_rate === undefined ? 100 : r.minor_unit_conversion_rate;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor)) return undefined;
  if (typeof currency !== "string" || !CURRENCY.test(currency)) return undefined;
  if (rate !== 1 && rate !== 10 && rate !== 100 && rate !== 1000) return undefined;
  return { cents: Math.round((minor * 100) / rate), currency };
}

/** Signed whole cents from an amount in whole units, or undefined. */
export function rampMajorAmount(amount: unknown, currency: unknown): { cents: number; currency: string } | undefined {
  if (typeof amount !== "number" || !Number.isFinite(amount) || Math.abs(amount) >= MAX_MAJOR) return undefined;
  if (typeof currency !== "string" || !CURRENCY.test(currency)) return undefined;
  // Rounded on the size, then signed, so half a cent rounds away from zero either way.
  const cents = Math.round(Math.abs(amount) * 100);
  return { cents: amount < 0 ? -cents : cents, currency };
}

/** The GL account a transaction is coded to, by name, or null. */
function glAccount(selections: unknown): string | null {
  if (!Array.isArray(selections)) return null;
  for (const s of selections) {
    const r = record(s);
    const type = r.type ?? record(r.category_info).type;
    if (type === "GL_ACCOUNT") return text(r.name);
  }
  return null;
}

export interface RampContext {
  receivedAt: string;
}

/** The event for one Ramp transaction. One that doesn't read is dead-lettered with its problems. */
export function rampTransactionEvent(raw: unknown, ctx: RampContext): RampEvent {
  const r = record(raw);
  const problems: string[] = [];
  const transactionId = id(r.id);
  if (!transactionId) problems.push("transaction has no ID that reads");
  const at = rampTime(r.user_transaction_time);
  if (!at) problems.push("transaction has no time that reads");
  const amount = rampMinorAmount(r.entity_amount) ?? rampMajorAmount(r.amount, r.currency_code);
  if (!amount) problems.push("transaction has no amount that reads");
  const original = rampMinorAmount(r.merchant_amount) ?? rampMinorAmount(r.original_transaction_amount);

  const holder = record(r.card_holder);
  const userId = id(holder.user_id);
  const refundOf = id(r.original_transaction_id);
  const state = typeof r.state === "string" && STATES.has(r.state) ? r.state.toLowerCase() : "unknown";
  const payload: Record<string, unknown> = {
    system: "Ramp",
    transactionId: transactionId ? rampTransactionRef(transactionId) : undefined,
    amountCents: amount ? Math.abs(amount.cents) : undefined,
    currency: amount?.currency,
    direction: amount && amount.cents < 0 ? "in" : "out",
    // Only when the merchant charged in another currency.
    originalAmountCents: original && original.currency !== amount?.currency ? Math.abs(original.cents) : null,
    originalCurrency: original && original.currency !== amount?.currency ? original.currency : null,
    state,
    merchantName: text(r.merchant_name),
    merchantCategoryCode: typeof r.merchant_category_code === "string" && /^\d{4}$/.test(r.merchant_category_code) ? r.merchant_category_code : null,
    spendCategory: text(r.sk_category_name),
    glAccount: glAccount(r.accounting_field_selections),
    cardholderRef: userId ? rampUserRef(userId) : null,
    department: text(holder.department_name),
    location: text(holder.location_name),
    hasReceipt: Array.isArray(r.receipts) && r.receipts.length > 0,
    hasMemo: text(r.memo) !== null,
    policyViolations: Array.isArray(r.policy_violations) ? r.policy_violations.length : 0,
    disputed: Array.isArray(r.disputes) && r.disputes.length > 0,
    readyToClose: typeof r.all_requirements_met_and_approved === "boolean" ? r.all_requirements_met_and_approved : null,
    refundOf: refundOf ? rampTransactionRef(refundOf) : null,
    transactedAt: at,
    settledAt: rampTime(r.settlement_date) ?? null,
  };

  const ok = problems.length === 0;
  const key = ok ? `ramp:transaction:${transactionId}:${short(payload)}` : `ramp:unreadable_transaction:${short(raw)}`;
  return {
    id: key.replace(/:/g, "_"),
    type: RAMP_TRANSACTION_EVENT,
    // One with a problem has no time, so it is dead-lettered.
    occurredAt: ok ? at : undefined,
    receivedAt: ctx.receivedAt,
    idempotencyKey: key,
    payload: ok ? payload : { system: "Ramp", transactionId: transactionId ?? null, problems },
  };
}
