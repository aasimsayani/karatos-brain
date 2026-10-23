/**
 * Turns Authorize.net's reporting records into Brain A events, in the same
 * neutral types the Stripe connector emits: payment.charge_updated,
 * payment.refund_updated, payment.dispute_updated for chargebacks and
 * returned eChecks, and payout.updated for each settlement batch, the money
 * Authorize.net sends on to the merchant's bank.
 *
 * Only what the departments use is kept. Like Stripe, a card is kept as its
 * brand only: no masked card or account number, no names, emails, phone
 * numbers, addresses, customer IPs, invoice numbers or descriptions.
 *
 * Authorize.net sends money as decimal amounts in the account's currency;
 * they become whole cents here, with the currency alongside. A transaction
 * keeps its id as it moves from authorized to captured to settled, so the
 * key is the id and the status: each status is stored once, and a replay is
 * a duplicate.
 */

/** One transaction as the transaction lists summarize it. */
export interface AuthorizeNetTransaction {
  transId?: string;
  submitTimeUTC?: string;
  transactionStatus?: string;
  accountType?: string;
  settleAmount?: number | string;
  marketType?: string;
  hasReturnedItems?: boolean;
  profile?: { customerProfileId?: string };
  [field: string]: unknown;
}

/** One settled batch, with the statistics the list returns when asked. */
export interface AuthorizeNetBatch {
  batchId?: string;
  settlementTimeUTC?: string;
  settlementState?: string;
  paymentMethod?: string;
  statistics?: unknown;
  [field: string]: unknown;
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface AuthorizeNetBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** What a transaction's events need beyond the record itself. */
export interface AuthorizeNetContext {
  /** The account's currency, from its merchant details. */
  currency: string;
  /** The settlement batch the transaction was listed under, if any. */
  batchId?: string;
  /** For a refund or chargeback: the transaction it refers to, from its details. */
  refTransId?: string;
}

const ID = /^\d{1,20}$/;
/** A table's own entry, never one inherited from Object (a status of "constructor" is just unknown). */
const own = <T>(table: Record<string, T>, key: unknown): T | undefined => (typeof key === "string" && Object.hasOwn(table, key) ? table[key] : undefined);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
const DECIMAL = /^-?\d{1,15}(\.\d{1,4})?$/;

export const authorizeNetRef = (kind: string, id: string) => `authorize_net:${kind}:${id}`;

/** A decimal amount in whole cents. Null for anything that isn't a number. */
export function authorizeNetCents(amount: unknown): number | null {
  if (typeof amount === "number") return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  return typeof amount === "string" && DECIMAL.test(amount.trim()) ? Math.round(Number(amount) * 100) : null;
}

/**
 * A UTC time Authorize.net wrote, as an ISO time. Its *UTC fields sometimes
 * leave out the Z; anything that isn't a time is undefined, so the pipeline
 * dead-letters the record rather than inventing one.
 */
export function authorizeNetTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !TIME.test(value.trim())) return undefined;
  const v = value.trim();
  const ms = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export const authorizeNetId = (value: unknown) => (typeof value === "string" && ID.test(value) ? value : undefined);

/**
 * A list under its own name, as the JSON API writes it, or under the XML
 * element name inside it (batchList.batch), which the translation may keep.
 */
export function authorizeNetList(value: unknown, inner: string): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : Array.isArray((value as Record<string, unknown> | null)?.[inner]) ? ((value as Record<string, unknown>)[inner] as unknown[]) : [];
  return items.filter((v): v is Record<string, unknown> => !!v && typeof v === "object");
}

/** Card brands as Authorize.net names them, in Stripe's spelling. */
const BRANDS: Record<string, string> = { Visa: "visa", MasterCard: "mastercard", AmericanExpress: "amex", Discover: "discover", JCB: "jcb", DinersClub: "diners" };

/** The sales department's payment method and the card brand, from accountType. */
export function authorizeNetMethod(accountType: unknown): { method: string; cardBrand: string | null } {
  if (typeof accountType !== "string" || !accountType.trim()) return { method: "other", cardBrand: null };
  const type = accountType.trim();
  if (/^(eCheck|PayPal)$/i.test(type)) return { method: "other", cardBrand: null };
  return { method: "card", cardBrand: own(BRANDS, type) ?? (type.toLowerCase().replace(/[^a-z]/g, "").slice(0, 20) || null) };
}

/** Where the sale happened, from marketType. */
const CHANNELS: Record<string, string> = { eCommerce: "online", Retail: "in_store", MOTO: "phone_or_mail" };

/** Charge statuses in Stripe's three, keeping Authorize.net's own alongside. */
const CHARGE: Record<string, "succeeded" | "pending" | "failed"> = {
  settledSuccessfully: "succeeded",
  capturedPendingSettlement: "succeeded",
  couldNotVoid: "succeeded",
  authorizedPendingCapture: "pending",
  authorizedPendingRelease: "pending",
  pendingSettlement: "pending",
  pendingFinalSettlement: "pending",
  updatingSettlement: "pending",
  underReview: "pending",
  approvedReview: "pending",
  FDSPendingReview: "pending",
  FDSAuthorizedPendingReview: "pending",
  declined: "failed",
  expired: "failed",
  failedReview: "failed",
  generalError: "failed",
  communicationError: "failed",
  settlementError: "failed",
  voided: "failed",
};
const CAPTURED = new Set(["settledSuccessfully", "capturedPendingSettlement", "couldNotVoid"]);
const REFUND: Record<string, string> = { refundSettledSuccessfully: "succeeded", refundPendingSettlement: "pending" };
/** Chargebacks and returned eChecks are their own transactions, pointing at the one they reverse. */
const DISPUTE: Record<string, { reason: string; status: string }> = {
  chargeback: { reason: "chargeback", status: "funds_withdrawn" },
  chargebackReversal: { reason: "chargeback", status: "funds_reinstated" },
  returnedItem: { reason: "returned_item", status: "funds_withdrawn" },
};

/** Transactions whose details are read for the transaction they refer to. */
export const authorizeNetNeedsLink = (status: unknown) => own(REFUND, status) !== undefined || own(DISPUTE, status) !== undefined;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): AuthorizeNetBrainEvent {
  return { id: `authorize_net_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `authorize_net:${key}`, payload };
}

/**
 * The event for one transaction. One with no usable id is dropped, since
 * there is nothing to key it by; one with no submit time has no occurredAt
 * and is dead-lettered.
 */
export function authorizeNetTransactionEvents(t: AuthorizeNetTransaction, context: AuthorizeNetContext, receivedAt: string): AuthorizeNetBrainEvent[] {
  if (!t || typeof t !== "object") return [];
  const id = authorizeNetId(t.transId);
  if (!id) return [];
  const status = typeof t.transactionStatus === "string" && /^[A-Za-z]{1,40}$/.test(t.transactionStatus) ? t.transactionStatus : "unknown";
  const occurredAt = authorizeNetTime(t.submitTimeUTC);
  const ref = authorizeNetRef("transaction", id);
  const linked = authorizeNetId(context.refTransId);
  const common = {
    amountCents: authorizeNetCents(t.settleAmount),
    currency: context.currency,
    ...(context.batchId ? { batchId: authorizeNetRef("batch", context.batchId) } : {}),
  };
  const key = `transaction:${id}:${status}`;
  const refund = own(REFUND, status);
  if (refund) {
    return [event(key, "payment.refund_updated", occurredAt, receivedAt, { refundId: ref, ...(linked ? { chargeId: authorizeNetRef("transaction", linked) } : {}), ...common, status: refund, reason: null })];
  }
  const dispute = own(DISPUTE, status);
  if (dispute) {
    return [event(key, "payment.dispute_updated", occurredAt, receivedAt, { disputeId: ref, ...(linked ? { chargeId: authorizeNetRef("transaction", linked) } : {}), ...common, ...dispute })];
  }
  const outcome = own(CHARGE, status) ?? "unknown";
  const customer = authorizeNetId(t.profile?.customerProfileId);
  const channel = own(CHANNELS, t.marketType);
  return [
    event(key, "payment.charge_updated", occurredAt, receivedAt, {
      chargeId: ref,
      status: outcome,
      gatewayStatus: status,
      paid: outcome === "succeeded",
      captured: CAPTURED.has(status),
      voided: status === "voided",
      ...common,
      capturedCents: CAPTURED.has(status) ? common.amountCents : 0,
      // Returned eChecks show here first; the returnedItem transaction carries the money.
      disputed: t.hasReturnedItems === true,
      ...authorizeNetMethod(t.accountType),
      ...(channel ? { channel } : {}),
      ...(customer ? { customerId: authorizeNetRef("customer_profile", customer) } : {}),
    }),
  ];
}

const SETTLEMENT: Record<string, string> = { settledSuccessfully: "paid", pendingSettlement: "pending", settlementError: "failed" };
const PAYMENT_METHODS: Record<string, string> = { creditCard: "card", eCheck: "echeck", payPal: "paypal" };

/** The sum of one statistic over a batch's account types, in cents; null when none can be read. */
function total(stats: Record<string, unknown>[], field: string): number | null {
  const cents = stats.map((s) => authorizeNetCents(s[field])).filter((c): c is number => c !== null);
  return cents.length ? cents.reduce((a, b) => a + b, 0) : null;
}

function count(stats: Record<string, unknown>[], field: string): number {
  return stats.reduce((n, s) => n + (Number.isInteger(s[field]) ? (s[field] as number) : /^\d+$/.test(String(s[field] ?? "")) ? Number(s[field]) : 0), 0);
}

/**
 * A settlement batch as a payout: what Authorize.net settled to the
 * merchant's bank, charges less refunds, with the counts behind it. The key
 * changes with the batch's settlement state.
 */
export function authorizeNetBatchEvents(b: AuthorizeNetBatch, currency: string, receivedAt: string): AuthorizeNetBrainEvent[] {
  if (!b || typeof b !== "object") return [];
  const id = authorizeNetId(b.batchId);
  if (!id) return [];
  const state = typeof b.settlementState === "string" && /^[A-Za-z]{1,40}$/.test(b.settlementState) ? b.settlementState : "unknown";
  const occurredAt = authorizeNetTime(b.settlementTimeUTC);
  const stats = authorizeNetList(b.statistics, "statistic");
  const charges = total(stats, "chargeAmount");
  const refunds = total(stats, "refundAmount");
  return [
    event(`batch:${id}:${state}`, "payout.updated", occurredAt, receivedAt, {
      payoutId: authorizeNetRef("batch", id),
      amountCents: charges === null && refunds === null ? null : (charges ?? 0) - (refunds ?? 0),
      currency,
      status: own(SETTLEMENT, state) ?? "unknown",
      method: own(PAYMENT_METHODS, b.paymentMethod) ?? "other",
      type: "settlement",
      arrivalDate: null,
      settledOn: occurredAt?.slice(0, 10) ?? null,
      chargeCents: charges,
      refundCents: refunds,
      chargebackCents: total(stats, "chargebackAmount"),
      returnedItemCents: total(stats, "returnedItemAmount"),
      chargeCount: count(stats, "chargeCount"),
      refundCount: count(stats, "refundCount"),
      voidCount: count(stats, "voidCount"),
      declineCount: count(stats, "declineCount"),
    }),
  ];
}
