import type { XeroEndpoint } from "./client.js";

/**
 * Turns Xero Accounting records into Brain A events, in the same
 * vendor-neutral types the QuickBooks connector uses (accounting.invoice_updated,
 * accounting.bill_updated, ...), so the departments read either set of books
 * the same way. Contacts marked as customers become clienteling profiles and
 * those marked as suppliers become vendors. Only what the departments use is
 * kept: no email addresses, phone numbers, street addresses, tax numbers,
 * bank details, references or narrations.
 *
 * Xero sends money as decimal amounts in the record's currency; they become
 * whole cents here, with the currency alongside. Xero has no version number,
 * so a key of record, id and UpdatedDateUTC stores every version once, and a
 * replay is a duplicate.
 */

interface ContactRef {
  ContactID?: string;
  Name?: string;
}

export interface XeroRecord {
  UpdatedDateUTC?: string;
  Status?: string;
  [field: string]: unknown;
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface XeroBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** The id field and event name of each endpoint's records. */
const RECORDS: Record<XeroEndpoint, { id: string; name: string }> = {
  Accounts: { id: "AccountID", name: "account" },
  Contacts: { id: "ContactID", name: "contact" },
  Invoices: { id: "InvoiceID", name: "invoice" },
  CreditNotes: { id: "CreditNoteID", name: "credit_note" },
  Payments: { id: "PaymentID", name: "payment" },
  BankTransactions: { id: "BankTransactionID", name: "bank_transaction" },
  ManualJournals: { id: "ManualJournalID", name: "journal_entry" },
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_DATE = /^\/Date\((-?\d{1,15})([+-]\d{4})?\)\/$/;

export const xeroRef = (name: string, id: string) => `xero:${name}:${id.toLowerCase()}`;

/** A decimal amount in whole cents. Null for anything that isn't a finite number. */
export function xeroCents(amount: unknown): number | null {
  return typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/**
 * A time Xero wrote, as an ISO time in UTC. Xero's JSON uses /Date(ms+0000)/,
 * and some fields an ISO string; anything else is undefined, so the pipeline
 * dead-letters the record rather than inventing a time.
 */
export function xeroTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const m = MS_DATE.exec(value.trim());
  // The milliseconds are UTC; the offset only says which zone Xero displayed.
  const ms = m ? Number(m[1]) : /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`) : Number.NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** The calendar day of a Xero date, as YYYY-MM-DD. */
const day = (value: unknown) => xeroTime(value)?.slice(0, 10);
const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const guid = (value: unknown) => (typeof value === "string" && GUID.test(value) ? value : undefined);
const status = (value: unknown) => text(value, 20)?.toLowerCase();

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): XeroBrainEvent {
  return { id: `xero_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `xero:${key}`, payload };
}

/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]).filter((v) => v && typeof v === "object") : []);

/** Customers and suppliers are both Xero contacts, so both refer to xero:contact:<id>. */
function contactRef(record: XeroRecord) {
  const id = guid((record.Contact as ContactRef | undefined)?.ContactID);
  return id ? xeroRef("contact", id) : undefined;
}

/** Event types and payloads for one record. A contact can be a customer and a supplier, so it may give two. */
function payloadsFor(endpoint: XeroEndpoint, r: XeroRecord, id: string): { type: string; suffix?: string; payload: Record<string, unknown> }[] {
  const currency = text(r.CurrencyCode, 3);
  const ref = xeroRef(RECORDS[endpoint].name, id);
  switch (endpoint) {
    case "Accounts":
      return [
        {
          type: "accounting.account_updated",
          payload: defined({
            accountId: ref,
            name: text(r.Name) ?? `Account ${text(r.Code, 20) ?? id}`,
            number: text(r.Code, 20),
            classification: text(r.Class, 40),
            accountType: text(r.Type, 60),
            active: r.Status !== "ARCHIVED",
            currency,
          }),
        },
      ];
    case "Contacts": {
      const out: { type: string; suffix: string; payload: Record<string, unknown> }[] = [];
      const name = text(r.Name);
      if (r.IsCustomer === true) {
        out.push({ type: "customer.profile_updated", suffix: "customer", payload: { customerId: ref, name: name ?? `Xero customer ${id}`, marketingConsent: false } });
      }
      if (r.IsSupplier === true) {
        out.push({ type: "accounting.vendor_updated", suffix: "vendor", payload: { vendorId: ref, name: name ?? `Xero supplier ${id}`, active: r.ContactStatus !== "ARCHIVED" } });
      }
      return out;
    }
    case "Invoices": {
      const common = {
        number: text(r.InvoiceNumber, 40),
        txnDate: day(r.Date),
        dueDate: day(r.DueDate),
        totalCents: xeroCents(r.Total),
        balanceCents: xeroCents(r.AmountDue),
        currency,
        status: status(r.Status),
      };
      if (r.Type === "ACCPAY") {
        return [
          {
            type: "accounting.bill_updated",
            payload: defined({ billId: xeroRef("bill", id), vendorId: contactRef(r), vendorName: text((r.Contact as ContactRef | undefined)?.Name), ...common }),
          },
        ];
      }
      return [
        {
          type: "accounting.invoice_updated",
          payload: defined({
            invoiceId: ref,
            customerId: contactRef(r),
            ...common,
            lines: list(r.LineItems).map((l) => defined({ amountCents: xeroCents(l.LineAmount), item: text(l.ItemCode, 60) ?? text(l.Description, 120), quantity: typeof l.Quantity === "number" ? l.Quantity : undefined })),
          }),
        },
      ];
    }
    case "CreditNotes": {
      const vendor = r.Type === "ACCPAYCREDIT";
      return [
        {
          type: "accounting.credit_note_updated",
          payload: defined({
            creditNoteId: ref,
            kind: vendor ? "vendor" : "customer",
            [vendor ? "vendorId" : "customerId"]: contactRef(r),
            number: text(r.CreditNoteNumber, 40),
            txnDate: day(r.Date),
            totalCents: xeroCents(r.Total),
            remainingCents: xeroCents(r.RemainingCredit),
            currency,
            status: status(r.Status),
          }),
        },
      ];
    }
    case "Payments": {
      const invoice = (r.Invoice ?? {}) as { InvoiceID?: unknown; Type?: unknown; CurrencyCode?: unknown; Contact?: ContactRef };
      const bill = invoice.Type === "ACCPAY";
      const invoiceId = guid(invoice.InvoiceID);
      const contactId = guid(invoice.Contact?.ContactID);
      return [
        {
          type: "accounting.payment_updated",
          payload: defined({
            paymentId: ref,
            [bill ? "vendorId" : "customerId"]: contactId && xeroRef("contact", contactId),
            txnDate: day(r.Date),
            totalCents: xeroCents(r.Amount),
            currency: text(invoice.CurrencyCode, 3) ?? currency,
            reconciled: r.IsReconciled === true,
            status: status(r.Status),
            appliedTo: invoiceId ? [{ type: bill ? "Bill" : "Invoice", id: xeroRef(bill ? "bill" : "invoice", invoiceId), amountCents: xeroCents(r.Amount) }] : [],
          }),
        },
      ];
    }
    case "BankTransactions": {
      const account = guid((r.BankAccount as { AccountID?: unknown } | undefined)?.AccountID);
      const contactId = guid((r.Contact as ContactRef | undefined)?.ContactID);
      return [
        {
          type: "accounting.bank_transaction_updated",
          payload: defined({
            bankTransactionId: ref,
            kind: text(r.Type, 20)?.toLowerCase(),
            bankAccountId: account && xeroRef("account", account),
            contactId: contactId && xeroRef("contact", contactId),
            txnDate: day(r.Date),
            totalCents: xeroCents(r.Total),
            currency,
            reconciled: r.IsReconciled === true,
            status: status(r.Status),
          }),
        },
      ];
    }
    case "ManualJournals":
      return [
        {
          type: "accounting.journal_entry_updated",
          payload: defined({
            journalEntryId: ref,
            txnDate: day(r.Date),
            status: status(r.Status),
            // Xero writes debits as positive line amounts and credits as negative ones.
            lines: list(r.JournalLines).map((l) => {
              const cents = xeroCents(l.LineAmount);
              return defined({ amountCents: cents === null ? null : Math.abs(cents), posting: cents === null ? undefined : cents >= 0 ? "debit" : "credit", accountCode: text(l.AccountCode, 20) });
            }),
          }),
        },
      ];
  }
}

/**
 * The events for one Xero record. A record with no usable id is dropped,
 * since there is nothing to key it by; one with no UpdatedDateUTC has no
 * occurredAt and is dead-lettered with the raw record kept. A deleted
 * transaction becomes accounting.record_deleted; a voided one stays an
 * update with status voided, since it still sits in the books.
 */
export function xeroEvents(endpoint: XeroEndpoint, record: XeroRecord, receivedAt: string): XeroBrainEvent[] {
  if (!record || typeof record !== "object") return [];
  const { id: idField, name } = RECORDS[endpoint];
  const id = guid(record[idField])?.toLowerCase();
  if (!id) return [];
  const occurredAt = xeroTime(record.UpdatedDateUTC);
  const version = occurredAt ? String(Date.parse(occurredAt)) : "0";
  const entity = endpoint === "Invoices" && record.Type === "ACCPAY" ? "bill" : name;
  if (record.Status === "DELETED" && endpoint !== "Accounts" && endpoint !== "Contacts") {
    return [event(`${entity}:${id}:deleted`, "accounting.record_deleted", occurredAt, receivedAt, { recordId: xeroRef(entity, id), entity })];
  }
  return payloadsFor(endpoint, record, id).map(({ type, suffix, payload }) => event(`${entity}:${id}:${version}${suffix ? `:${suffix}` : ""}`, type, occurredAt, receivedAt, payload));
}

/** Every event in one page of records from an endpoint. */
export function xeroPageEvents(endpoint: XeroEndpoint, records: unknown, receivedAt: string): XeroBrainEvent[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => xeroEvents(endpoint, r as XeroRecord, receivedAt));
}
