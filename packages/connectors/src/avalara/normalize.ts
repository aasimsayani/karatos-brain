import { createHash, createHmac } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";

/**
 * Turns an AvaTax transaction into one Brain A event: the tax charged on a
 * sale, return or purchase, by jurisdiction. It is keyed by the transaction
 * and what was read, so reading it again is a duplicate and a change (a
 * commit, a void, an adjustment) is a new event.
 *
 * Transactions can name the customer, so the event keeps the money and the
 * places and drops the person:
 *
 * - the customer code becomes a keyed reference, and an email address only
 *   makes the same customer references custom forms and Klaviyo make;
 *   neither is kept, and nor are the customer or vendor name, addresses,
 *   the exemption certificate number, business or VAT numbers, purchase
 *   order numbers, descriptions or the salesperson;
 * - the jurisdiction summary (state, county, city and special districts,
 *   with their rates and amounts) is kept, since that is what the finance
 *   and compliance departments file by.
 *
 * A transaction without an id, a day or a change time that reads is
 * dead-lettered listing what was wrong.
 */

export interface AvalaraEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const AVALARA_EVENT_TYPE = "tax.transaction_updated";

/** Document types AvaTax records, by what they mean to the business. */
const KINDS: Record<string, "sale" | "return" | "purchase" | "transfer" | "reverse_charge" | "customs"> = {
  SalesOrder: "sale",
  SalesInvoice: "sale",
  ReturnOrder: "return",
  ReturnInvoice: "return",
  PurchaseOrder: "purchase",
  PurchaseInvoice: "purchase",
  InventoryTransferOrder: "transfer",
  InventoryTransferInvoice: "transfer",
  InventoryTransferOutboundOrder: "transfer",
  InventoryTransferOutboundInvoice: "transfer",
  ReverseChargeOrder: "reverse_charge",
  ReverseChargeInvoice: "reverse_charge",
  CustomsOrder: "customs",
  CustomsInvoice: "customs",
};
const STATUSES = new Set(["Temporary", "Saved", "Posted", "Committed", "Cancelled", "Adjusted", "Queued", "PendingApproval", "Uncommitted"]);
const JURIS_TYPES = new Set(["Country", "State", "County", "City", "Special"]);
const MAX_JURISDICTIONS = 100;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const word = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);

/** Whole cents from an AvaTax amount in currency units. Null when it isn't a number. */
export function avalaraCents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e13 ? Math.round(Number((value * 100).toPrecision(15))) : null;
}

/** A YYYY-MM-DD day, from a day or a day with a midnight time, or null when it isn't a real day. */
export function avalaraDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T00:00:00(\.0+)?Z?)?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === day ? day : null;
}

/** An AvaTax time as ISO, read as UTC (AvaTax writes up to seven decimals and sometimes no Z), or null when it isn't one. */
export function avalaraTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,7})?Z?$/.exec(value);
  if (!m || avalaraDay(m[1]) === null) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}Z`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A keyed reference for an AvaTax customer code, the same for every transaction of that customer in this company. */
export function avalaraCustomerRef(key: string, accountId: string, companyCode: string, code: unknown): string | undefined {
  if (typeof code !== "string" || code.trim() === "" || code.length > 50) return undefined;
  const mac = createHmac("sha256", key).update(`avalara_customer:${accountId}:${companyCode}:${code.trim()}`, "utf8").digest("hex");
  return `avalara_customer:${mac.slice(0, 32)}`;
}

export interface AvalaraContext {
  customerKey: string;
  accountId: string;
  companyCode: string;
  receivedAt: string;
}

export type AvalaraRead = { ok: boolean; event: AvalaraEvent };

function jurisdiction(raw: unknown): Record<string, unknown> | null {
  const j = obj(raw);
  if (!j) return null;
  return {
    country: word(j.country, /^[A-Z]{2}$/),
    region: word(j.region, /^[A-Z0-9]{1,3}$/),
    type: word(j.jurisType, /^[A-Za-z]{1,20}$/) && JURIS_TYPES.has(j.jurisType as string) ? j.jurisType : "Other",
    code: word(j.jurisCode, /^[A-Za-z0-9-]{1,20}$/),
    name: word(j.jurisName, /^[\p{L}\p{N} .,'&()/-]{1,80}$/u),
    taxType: word(j.taxType, /^[A-Za-z]{1,30}$/),
    taxName: word(j.taxName, /^[\p{L}\p{N} .,'&()/-]{1,80}$/u),
    rate: typeof j.rate === "number" && Number.isFinite(j.rate) && j.rate >= 0 && j.rate < 1 ? j.rate : null,
    taxableCents: avalaraCents(j.taxable),
    taxCents: avalaraCents(j.tax),
    taxCalculatedCents: avalaraCents(j.taxCalculated),
    nonTaxableCents: avalaraCents(j.nonTaxable),
    exemptCents: avalaraCents(j.exemption),
  };
}

export function avalaraTransactionEvent(raw: unknown, ctx: AvalaraContext): AvalaraRead {
  const problems: string[] = [];
  const t = obj(raw) ?? {};
  if (!obj(raw)) problems.push("transaction is not an object");
  const transactionId = typeof t.id === "number" && Number.isSafeInteger(t.id) && t.id > 0 ? t.id : undefined;
  if (transactionId === undefined) problems.push("transaction has no id that reads");
  const day = avalaraDay(t.date);
  if (!day) problems.push("transaction has no day that reads");
  const modifiedAt = avalaraTime(t.modifiedDate);
  if (!modifiedAt) problems.push("transaction has no change time that reads");
  const type = typeof t.type === "string" && t.type in KINDS ? t.type : undefined;
  if (!type) problems.push("transaction type is not one AvaTax documents");
  const status = typeof t.status === "string" && STATUSES.has(t.status) ? t.status : undefined;
  if (!status) problems.push("transaction status is not one AvaTax documents");
  const totalTaxCents = avalaraCents(t.totalTax);
  if (totalTaxCents === null) problems.push("transaction has no total tax that reads");

  const summary = Array.isArray(t.summary) ? t.summary : [];
  const jurisdictions = summary.slice(0, MAX_JURISDICTIONS).map(jurisdiction).filter((j): j is Record<string, unknown> => !!j);
  const payload: Record<string, unknown> = {
    system: "Avalara AvaTax",
    transactionId,
    companyCode: ctx.companyCode,
    documentCode: word(t.code, /^[A-Za-z0-9_.#:-]{1,50}$/),
    kind: type ? KINDS[type] : undefined,
    documentType: type,
    status,
    day,
    taxDay: avalaraDay(t.taxDate) ?? undefined,
    currency: word(t.currencyCode, /^[A-Z]{3}$/),
    totalAmountCents: avalaraCents(t.totalAmount),
    totalTaxableCents: avalaraCents(t.totalTaxable),
    totalExemptCents: avalaraCents(t.totalExempt),
    totalTaxCents,
    totalTaxCalculatedCents: avalaraCents(t.totalTaxCalculated),
    region: word(t.region, /^[A-Z0-9]{1,3}$/),
    country: word(t.country, /^[A-Z]{2}$/),
    locationCode: word(t.locationCode, /^[A-Za-z0-9_.-]{1,50}$/),
    // The reason code a sale was exempt, such as resale (G) or charity (E); never the certificate number.
    exemptReason: word(t.entityUseCode, /^[A-Za-z0-9]{1,25}$/) ?? word(t.customerUsageType, /^[A-Za-z0-9]{1,25}$/),
    hasExemptionCertificate: typeof t.exemptNo === "string" && t.exemptNo.trim() !== "",
    taxOverride: word(t.taxOverrideType, /^[A-Za-z]{1,30}$/) && t.taxOverrideType !== "None" ? t.taxOverrideType : undefined,
    adjustmentReason: word(t.adjustmentReason, /^[A-Za-z]{1,40}$/) && t.adjustmentReason !== "NotAdjusted" ? t.adjustmentReason : undefined,
    version: typeof t.version === "number" && Number.isSafeInteger(t.version) ? t.version : undefined,
    reconciled: t.reconciled === true,
    locked: t.locked === true,
    customerRef: avalaraCustomerRef(ctx.customerKey, ctx.accountId, ctx.companyCode, t.customerCode),
    customerRefs: formCustomerRefs(ctx.customerKey, { email: t.email }),
    jurisdictions,
    modifiedAt,
  };
  const ok = problems.length === 0;
  const hash = short(payload);
  const key = ok ? `avalara:transaction:${transactionId}:${hash}` : `avalara:unreadable_transaction:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type: AVALARA_EVENT_TYPE,
      // A change happens when AvaTax recorded it. One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? (modifiedAt ?? undefined) : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: "Avalara AvaTax", transactionId: transactionId ?? null, problems },
    },
  };
}
