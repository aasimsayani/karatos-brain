/**
 * Turns QuickBooks Online entities into Brain A events. The books keep their
 * own shape under QuickBooks-neutral types (accounting.invoice_updated,
 * accounting.bill_updated, ...). Customers become clienteling profiles.
 * Only what the departments use is kept: no email addresses, phone numbers,
 * street addresses, tax IDs or notes.
 *
 * QuickBooks sends money as decimal amounts in the company's currency; they
 * become whole cents here, with the currency alongside.
 *
 * Each change to an entity raises its SyncToken, so a key of entity, id and
 * SyncToken stores every version once, and a replay is a duplicate.
 */

/** Entities the connector reads, in the order the historical import reads them. */
export const QUICKBOOKS_ENTITIES = ["Account", "Customer", "Vendor", "Invoice", "Bill", "Payment", "JournalEntry"] as const;
export type QuickBooksEntity = (typeof QUICKBOOKS_ENTITIES)[number];

/** Name lists: QuickBooks returns only active ones unless asked, and their history isn't dated by a transaction. */
export const QUICKBOOKS_NAME_LISTS: readonly QuickBooksEntity[] = ["Account", "Customer", "Vendor"];

interface Ref {
  value?: string;
  name?: string;
}

export interface QuickBooksRecord {
  Id?: string;
  SyncToken?: string;
  /** CDC marks deleted entities this way. */
  status?: string;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
  CurrencyRef?: Ref;
  [field: string]: unknown;
}

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface QuickBooksBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

const SNAKE: Record<QuickBooksEntity, string> = {
  Account: "account",
  Customer: "customer",
  Vendor: "vendor",
  Invoice: "invoice",
  Bill: "bill",
  Payment: "payment",
  JournalEntry: "journal_entry",
};

export const quickBooksRef = (entity: QuickBooksEntity, id: string) => `quickbooks:${SNAKE[entity]}:${id}`;

/** A decimal amount in whole cents. Null for anything that isn't a finite number. */
export function quickBooksCents(amount: unknown): number | null {
  return typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** An ISO time QuickBooks wrote, normalized to UTC. Undefined when missing or unreadable, so the pipeline dead-letters the record. */
export function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : undefined);
const ref = (r: unknown) => {
  const v = r as Ref | undefined;
  return typeof v?.value === "string" && v.value ? v.value : undefined;
};
const refName = (r: unknown) => text((r as Ref | undefined)?.name);
const date = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): QuickBooksBrainEvent {
  return { id: `quickbooks_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `quickbooks:${key}`, payload };
}

/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

function linesOf(record: QuickBooksRecord) {
  const lines = Array.isArray(record.Line) ? (record.Line as Record<string, unknown>[]) : [];
  return lines.filter((l) => l && typeof l === "object");
}

function linked(record: QuickBooksRecord) {
  return linesOf(record).flatMap((line) =>
    (Array.isArray(line.LinkedTxn) ? (line.LinkedTxn as { TxnId?: unknown; TxnType?: unknown }[]) : []).flatMap((t) =>
      typeof t?.TxnId === "string" && typeof t.TxnType === "string" ? [{ type: t.TxnType, id: t.TxnId, amountCents: quickBooksCents(line.Amount) }] : [],
    ),
  );
}

function payloadFor(entity: QuickBooksEntity, r: QuickBooksRecord): { type: string; payload: Record<string, unknown> } {
  const id = r.Id!;
  const currency = text(r.CurrencyRef?.value, 3);
  switch (entity) {
    case "Account":
      return {
        type: "accounting.account_updated",
        payload: defined({
          accountId: quickBooksRef(entity, id),
          name: text(r.Name) ?? `Account ${id}`,
          number: text(r.AcctNum, 20),
          classification: text(r.Classification, 40),
          accountType: text(r.AccountType, 60),
          accountSubType: text(r.AccountSubType, 60),
          active: r.Active !== false,
          currentBalanceCents: quickBooksCents(r.CurrentBalance),
          currency,
        }),
      };
    case "Customer":
      return {
        type: "customer.profile_updated",
        payload: { customerId: quickBooksRef(entity, id), name: text(r.DisplayName) || `QuickBooks customer ${id}`, marketingConsent: false },
      };
    case "Vendor":
      return {
        type: "accounting.vendor_updated",
        payload: defined({ vendorId: quickBooksRef(entity, id), name: text(r.DisplayName) || `QuickBooks vendor ${id}`, active: r.Active !== false, balanceCents: quickBooksCents(r.Balance), currency }),
      };
    case "Invoice":
      return {
        type: "accounting.invoice_updated",
        payload: defined({
          invoiceId: quickBooksRef(entity, id),
          number: text(r.DocNumber, 40),
          customerId: ref(r.CustomerRef) && quickBooksRef("Customer", ref(r.CustomerRef)!),
          txnDate: date(r.TxnDate),
          dueDate: date(r.DueDate),
          totalCents: quickBooksCents(r.TotalAmt),
          balanceCents: quickBooksCents(r.Balance),
          currency,
          lines: linesOf(r)
            .filter((l) => l.DetailType === "SalesItemLineDetail")
            .map((l) => defined({ amountCents: quickBooksCents(l.Amount), item: refName((l.SalesItemLineDetail as { ItemRef?: Ref } | undefined)?.ItemRef), quantity: (l.SalesItemLineDetail as { Qty?: unknown } | undefined)?.Qty })),
        }),
      };
    case "Bill":
      return {
        type: "accounting.bill_updated",
        payload: defined({
          billId: quickBooksRef(entity, id),
          number: text(r.DocNumber, 40),
          vendorId: ref(r.VendorRef) && quickBooksRef("Vendor", ref(r.VendorRef)!),
          vendorName: refName(r.VendorRef),
          txnDate: date(r.TxnDate),
          dueDate: date(r.DueDate),
          totalCents: quickBooksCents(r.TotalAmt),
          balanceCents: quickBooksCents(r.Balance),
          currency,
        }),
      };
    case "Payment":
      return {
        type: "accounting.payment_updated",
        payload: defined({
          paymentId: quickBooksRef(entity, id),
          customerId: ref(r.CustomerRef) && quickBooksRef("Customer", ref(r.CustomerRef)!),
          txnDate: date(r.TxnDate),
          totalCents: quickBooksCents(r.TotalAmt),
          unappliedCents: quickBooksCents(r.UnappliedAmt),
          currency,
          appliedTo: linked(r),
        }),
      };
    case "JournalEntry":
      return {
        type: "accounting.journal_entry_updated",
        payload: defined({
          journalEntryId: quickBooksRef(entity, id),
          number: text(r.DocNumber, 40),
          txnDate: date(r.TxnDate),
          adjustment: r.Adjustment === true,
          currency,
          lines: linesOf(r).map((l) => {
            const detail = (l.JournalEntryLineDetail ?? {}) as { PostingType?: unknown; AccountRef?: Ref };
            return defined({
              amountCents: quickBooksCents(l.Amount),
              posting: detail.PostingType === "Debit" ? "debit" : detail.PostingType === "Credit" ? "credit" : undefined,
              accountId: ref(detail.AccountRef) && quickBooksRef("Account", ref(detail.AccountRef)!),
              accountName: refName(detail.AccountRef),
            });
          }),
        }),
      };
  }
}

/**
 * The event for one QuickBooks entity. A record with no Id is dropped, since
 * there is nothing to key it by; one with no LastUpdatedTime has no
 * occurredAt and is dead-lettered with the raw record kept.
 */
export function quickBooksEvent(entity: QuickBooksEntity, record: QuickBooksRecord, receivedAt: string): QuickBooksBrainEvent | null {
  if (!record || typeof record.Id !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(record.Id)) return null;
  const occurredAt = isoTime(record.MetaData?.LastUpdatedTime);
  if (record.status === "Deleted") {
    return event(`${SNAKE[entity]}:${record.Id}:deleted`, "accounting.record_deleted", occurredAt, receivedAt, { recordId: quickBooksRef(entity, record.Id), entity: SNAKE[entity] });
  }
  const version = typeof record.SyncToken === "string" && /^\d{1,10}$/.test(record.SyncToken) ? record.SyncToken : "0";
  const { type, payload } = payloadFor(entity, record);
  return event(`${SNAKE[entity]}:${record.Id}:${version}`, type, occurredAt, receivedAt, payload);
}

/** Every event in one page of query or CDC results for an entity. */
export function quickBooksEvents(entity: QuickBooksEntity, records: unknown, receivedAt: string): QuickBooksBrainEvent[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => quickBooksEvent(entity, r as QuickBooksRecord, receivedAt) ?? []);
}
