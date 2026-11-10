import type { BillResource } from "./client.js";

/**
 * Turns BILL records into Brain A events, in the same vendor-neutral types
 * the QuickBooks and Xero connectors use (accounting.vendor_updated,
 * accounting.bill_updated, accounting.payment_updated), so the departments
 * read any of them the same way. Only what the departments use is kept:
 * no email addresses, phone numbers, street addresses, tax ids, vendor
 * account numbers, bank details, card digits, check numbers, descriptions
 * or memos.
 *
 * BILL sends money as decimal amounts in the record's currency; they
 * become whole cents here. BILL has no version number, so a key of record,
 * id and updatedTime stores every version once, and a replay is a
 * duplicate. A record without a readable id or updatedTime becomes an
 * event with no time, which the pipeline dead-letters.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface BillBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Each list's event type, record name and id prefix ("009" vendors, "00n" bills, "stp" payments). */
export const BILL_RECORDS: Record<BillResource, { type: string; name: string; prefix: string }> = {
  vendors: { type: "accounting.vendor_updated", name: "vendor", prefix: "009" },
  bills: { type: "accounting.bill_updated", name: "bill", prefix: "00n" },
  payments: { type: "accounting.payment_updated", name: "payment", prefix: "stp" },
};

const ID = /^[A-Za-z0-9]{4,40}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENUM = /^[A-Z][A-Z0-9_]{0,39}$/;
/** Larger than any bill a jewelry business pays; anything bigger is read as a mistake. */
const MAX_AMOUNT = 1e11;

export const billRef = (name: string, id: string) => `bill:${name}:${id}`;

/** A BILL id with the prefix BILL gives that kind of record, else undefined. */
export function billId(value: unknown, prefix: string): string | undefined {
  return typeof value === "string" && ID.test(value) && value.startsWith(prefix) ? value : undefined;
}

/** A decimal amount in whole cents. Null for anything that isn't a finite number of a sane size. */
export function billCents(amount: unknown): number | null {
  return typeof amount === "number" && Number.isFinite(amount) && Math.abs(amount) < MAX_AMOUNT ? Math.round(amount * 100) : null;
}

/** A BILL date-time as an ISO time in UTC; undefined for anything else. */
export function billTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined;
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A BILL calendar date, yyyy-MM-dd, when it is a real day. */
export function billDay(value: unknown): string | undefined {
  const m = typeof value === "string" ? DAY.exec(value) : null;
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value ? value : undefined;
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
/** BILL's upper-case enum values, lowercased; UNDEFINED and anything else unreadable are left out. */
const status = (value: unknown) => (typeof value === "string" && ENUM.test(value) && value !== "UNDEFINED" ? value.toLowerCase() : undefined);
const currency = (value: unknown) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const vendorRef = (value: unknown) => {
  const id = billId(value, "009");
  return id && billRef("vendor", id);
};

function payloadOf(resource: BillResource, r: Record<string, unknown>, id: string): Record<string, unknown> {
  switch (resource) {
    case "vendors": {
      const pay = isObject(r.paymentInformation) ? r.paymentInformation : {};
      return defined({
        vendorId: billRef("vendor", id),
        name: text(r.name, 200) ?? `BILL vendor ${id}`,
        active: r.archived !== true,
        currency: currency(r.billCurrency),
        payBy: status(pay.payByType),
      });
    }
    case "bills": {
      const invoice = isObject(r.invoice) ? r.invoice : {};
      return defined({
        billId: billRef("bill", id),
        vendorId: vendorRef(r.vendorId),
        vendorName: text(r.vendorName, 200),
        number: text(invoice.invoiceNumber, 100),
        txnDate: billDay(invoice.invoiceDate),
        dueDate: billDay(r.dueDate),
        totalCents: billCents(r.amount),
        balanceCents: billCents(r.dueAmount),
        paidCents: billCents(r.paidAmount) ?? undefined,
        scheduledCents: billCents(r.scheduledAmount) ?? undefined,
        currency: currency(r.currency),
        status: status(r.paymentStatus),
        approvalStatus: status(r.approvalStatus),
        archived: r.archived === true,
      });
    }
    case "payments": {
      const applied = (Array.isArray(r.billPayments) ? r.billPayments : []).filter(isObject).flatMap((p) => {
        const bill = billId(p.billId, "00n");
        return bill ? [{ type: "Bill", id: billRef("bill", bill), amountCents: billCents(p.amount) }] : [];
      });
      const single = billId(r.billId, "00n");
      return defined({
        paymentId: billRef("payment", id),
        vendorId: vendorRef(r.vendorId),
        vendorName: text(r.vendorName, 200),
        txnDate: billDay(r.processDate),
        totalCents: billCents(r.amount),
        fundingCents: billCents(r.fundingAmount) ?? undefined,
        status: status(r.status),
        method: status(r.disbursementType),
        online: r.onlinePayment === true,
        appliedTo: applied.length || !single ? applied : [{ type: "Bill", id: billRef("bill", single), amountCents: billCents(r.amount) }],
      });
    }
  }
}

/** One BILL record as one event. */
export function billEvent(resource: BillResource, record: Record<string, unknown>, receivedAt: string): BillBrainEvent {
  const { type, name, prefix } = BILL_RECORDS[resource];
  const id = billId(record.id, prefix);
  const updatedAt = billTime(record.updatedTime);
  if (!id || !updatedAt) {
    // No id or time: dead-lettered, keeping only what says which record it was.
    const raw = typeof record.id === "string" ? record.id.slice(0, 40) : "";
    const key = `${name}:unreadable:${raw}:${typeof record.updatedTime === "string" ? record.updatedTime.slice(0, 40) : ""}`;
    return { id: `bill_com_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt: undefined, receivedAt, idempotencyKey: `bill_com:${key}`, payload: { problem: !id ? `no ${name} id` : "no updatedTime", billRecordId: raw } };
  }
  const key = `${name}:${id}:${updatedAt}`;
  return { id: `bill_com_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt: updatedAt, receivedAt, idempotencyKey: `bill_com:${key}`, payload: payloadOf(resource, record, id) };
}
