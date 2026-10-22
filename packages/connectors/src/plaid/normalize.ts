import { createHash } from "node:crypto";
import { bankCategory, type AccountKind } from "../bank_statements/normalize.js";
import { GENERIC_BANK_PROFILE, type BankProfile } from "../bank_statements/profile.js";
import type { PlaidAccount, PlaidRemovedTransaction, PlaidTransaction } from "./client.js";

/**
 * Turns Plaid accounts and transactions into Brain A events. A posted
 * transaction becomes `bank.transaction_imported` in the shape the bank
 * statements connector uses, so the finance department reads a Plaid feed
 * and a statement the same way.
 *
 * Plaid reports three kinds of change, and each gets its own type:
 * - `added`: `bank.transaction_imported`, keyed by the transaction alone, so
 *   finance counts each transaction once however often it is read.
 * - `modified`: `bank.transaction_updated`, keyed by the transaction and what
 *   changed, so each version is stored once without finance counting the
 *   money twice.
 * - `removed`: `bank.transaction_removed`. It is a bank record, not a book
 *   entry, so it stays with the other bank events rather than QuickBooks'
 *   `accounting.record_deleted`, and names the same `transactionId` the
 *   import used.
 *
 * Pending transactions are skipped. A statement lists only posted ones, and
 * Plaid removes a pending transaction when it posts and adds the posted one
 * under a new ID, so keeping both would count the money twice.
 *
 * Only what the departments use is kept: no account numbers, owner names,
 * locations, payment details (payee, payer, reference numbers) or
 * counterparties. Plaid's account IDs are opaque, and an account's mask is
 * at most its last four digits.
 *
 * Plaid signs amounts with money out positive. Here, as in the bank
 * statements connector, money into the account is positive and money out is
 * negative, in whole cents.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface PlaidBrainEvent {
  id: string;
  type: "bank.transaction_imported" | "bank.transaction_updated" | "bank.transaction_removed" | "bank.account_updated";
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** What a transaction's account is, for categorizing it. Accounts Plaid didn't list count as bank accounts. */
export type PlaidAccountKinds = ReadonlyMap<string, AccountKind>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const plaidAccountRef = (id: string) => `plaid:account:${id}`;
export const plaidTransactionRef = (id: string) => `plaid:transaction:${id}`;

/** A Plaid amount (money out positive) as signed whole cents, money in positive. Null for anything that isn't a finite number. */
export function plaidCents(amount: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  // Rounded on the size, then signed, so half a cent rounds away from zero either way.
  const cents = Math.round(Math.abs(amount) * 100);
  return cents === 0 ? 0 : amount > 0 ? -cents : cents;
}

/** A balance as Plaid reports it, in whole cents, without changing its sign. */
export function plaidBalanceCents(amount: unknown): number | null | undefined {
  if (amount === null || amount === undefined) return amount;
  return typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/** Plaid's account type as the bank statements connector's kind. */
export const plaidAccountKind = (type: unknown): AccountKind => (type === "credit" ? "credit_card" : "bank");

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
/** A YYYY-MM-DD day that exists: 2026-02-30 is refused rather than rolled into March. */
function day(value: unknown): string | undefined {
  if (typeof value !== "string" || !DAY.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : undefined;
}
const currencyOf = (iso: unknown, unofficial: unknown) => text(iso, 3) ?? text(unofficial, 12);

/** Optional fields are left out rather than sent as undefined. */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A short hash of what an event says, so a version that says the same thing again is a duplicate. */
const versionOf = (payload: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);

function event(type: PlaidBrainEvent["type"], key: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): PlaidBrainEvent {
  return { id: `plaid_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `plaid:${key}`, payload };
}

/** The finance payload for one transaction: the same fields a statement line gives, plus what Plaid adds that departments use. */
function transactionPayload(t: PlaidTransaction & { transaction_id: string }, kinds: PlaidAccountKinds, profile: BankProfile): Record<string, unknown> {
  const accountId = typeof t.account_id === "string" && ID.test(t.account_id) ? t.account_id : undefined;
  const accountKind = (accountId && kinds.get(accountId)) || "bank";
  const amountCents = plaidCents(t.amount);
  const merchantName = text(t.merchant_name);
  const description = text(t.name) ?? merchantName ?? "";
  return defined({
    transactionId: plaidTransactionRef(t.transaction_id),
    accountId: accountId ? plaidAccountRef(accountId) : undefined,
    accountKind,
    amountCents,
    description,
    category: bankCategory(description, amountCents, accountKind, profile),
    currency: currencyOf(t.iso_currency_code, t.unofficial_currency_code),
    merchantName,
    checkNumber: text(t.check_number, 20),
    plaidCategory: text(t.personal_finance_category?.primary, 60),
    authorizedDate: day(t.authorized_date),
  });
}

/**
 * The event for one added or modified transaction. A transaction with no
 * usable ID is dropped, since there is nothing to key it by, and a pending
 * one is skipped (see above). One with no readable date or amount keeps
 * them missing or null, so the pipeline dead-letters it with the raw record
 * kept.
 */
export function plaidTransactionEvent(
  change: "added" | "modified",
  t: PlaidTransaction,
  receivedAt: string,
  kinds: PlaidAccountKinds = new Map(),
  profile: BankProfile = GENERIC_BANK_PROFILE,
): PlaidBrainEvent | null {
  if (!t || typeof t.transaction_id !== "string" || !ID.test(t.transaction_id) || t.pending === true) return null;
  const date = day(t.date);
  const occurredAt = date ? `${date}T00:00:00.000Z` : undefined;
  const payload = transactionPayload(t as PlaidTransaction & { transaction_id: string }, kinds, profile);
  if (change === "added") return event("bank.transaction_imported", `transaction:${t.transaction_id}`, occurredAt, receivedAt, payload);
  return event("bank.transaction_updated", `transaction:${t.transaction_id}:${versionOf(payload)}`, occurredAt, receivedAt, payload);
}

/** A transaction Plaid removed. Plaid gives no time, so it is dated when the removal was read. */
export function plaidRemovedEvent(r: PlaidRemovedTransaction, receivedAt: string): PlaidBrainEvent | null {
  if (!r || typeof r.transaction_id !== "string" || !ID.test(r.transaction_id)) return null;
  const accountId = typeof r.account_id === "string" && ID.test(r.account_id) ? plaidAccountRef(r.account_id) : undefined;
  return event("bank.transaction_removed", `transaction:${r.transaction_id}:removed`, receivedAt, receivedAt, defined({ transactionId: plaidTransactionRef(r.transaction_id), accountId }));
}

/**
 * An account and its balances. Balances keep Plaid's sign: for a bank
 * account the money in it, for a card what is owed. Keyed by what the event
 * says, so a sync that finds the same balances stores nothing new.
 */
export function plaidAccountEvent(a: PlaidAccount, receivedAt: string): PlaidBrainEvent | null {
  if (!a || typeof a.account_id !== "string" || !ID.test(a.account_id)) return null;
  const b = a.balances ?? {};
  const payload = defined({
    accountId: plaidAccountRef(a.account_id),
    accountKind: plaidAccountKind(a.type),
    name: text(a.name, 100) ?? `Plaid account ${a.account_id.slice(-4)}`,
    mask: typeof a.mask === "string" && /^[A-Za-z0-9]{2,4}$/.test(a.mask) ? a.mask : undefined,
    type: text(a.type, 30),
    subtype: text(a.subtype, 40),
    currentBalanceCents: plaidBalanceCents(b.current),
    availableBalanceCents: plaidBalanceCents(b.available),
    limitCents: plaidBalanceCents(b.limit),
    currency: currencyOf(b.iso_currency_code, b.unofficial_currency_code),
  });
  const updated = typeof b.last_updated_datetime === "string" && !Number.isNaN(Date.parse(b.last_updated_datetime)) ? new Date(b.last_updated_datetime).toISOString() : receivedAt;
  return event("bank.account_updated", `account:${a.account_id}:${versionOf(payload)}`, updated, receivedAt, payload);
}

/** Each account's kind, by Plaid account ID. */
export function plaidAccountKinds(accounts: readonly PlaidAccount[]): PlaidAccountKinds {
  return new Map(accounts.flatMap((a) => (typeof a?.account_id === "string" ? [[a.account_id, plaidAccountKind(a.type)] as const] : [])));
}

/** Every event in one page of /transactions/sync. */
export function plaidSyncEvents(
  page: { added: readonly PlaidTransaction[]; modified: readonly PlaidTransaction[]; removed: readonly PlaidRemovedTransaction[] },
  receivedAt: string,
  kinds: PlaidAccountKinds = new Map(),
  profile: BankProfile = GENERIC_BANK_PROFILE,
): PlaidBrainEvent[] {
  return [
    ...page.added.flatMap((t) => plaidTransactionEvent("added", t, receivedAt, kinds, profile) ?? []),
    ...page.modified.flatMap((t) => plaidTransactionEvent("modified", t, receivedAt, kinds, profile) ?? []),
    ...page.removed.flatMap((r) => plaidRemovedEvent(r, receivedAt) ?? []),
  ];
}
