import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import type { BankProfile } from "../bank_statements/profile.js";
import { PLAID_CURSOR, PlaidApiError, plaidClient, type PlaidClient, type PlaidClientOptions } from "./client.js";
import { plaidAccountEvent, plaidAccountKinds, plaidSyncEvents, type PlaidAccountKinds } from "./normalize.js";

/**
 * Reads one Plaid Item: its accounts and balances, then every transaction
 * change through /transactions/sync. Each pass reads the accounts first,
 * then pages through the changes after the saved Plaid cursor until Plaid
 * says there are no more. The historical import starts with no cursor, which
 * gives the Item's whole history (up to 24 months, as much as was asked for
 * when the bank was linked); incremental syncs carry on from the cursor the
 * last pass ended on.
 */

/**
 * Declared so they can be gated and audited. None runs while writes are off,
 * the client calls read endpoints only, and the connector never asks Plaid
 * for a product that moves money.
 */
export const PLAID_WRITES: WriteAction[] = [
  { integration: "plaid", name: "create_transfer", description: "Move money between the business's linked bank and another account" },
  { integration: "plaid", name: "remove_item", description: "Disconnect the linked bank from Plaid" },
  { integration: "plaid", name: "create_processor_token", description: "Hand the linked bank account to a payment processor" },
];

/** Restarts of one pagination loop after Plaid reports the data changed under it, before the error goes to runSync. */
export const PLAID_MUTATION_RESTARTS = 3;

type Step = "accounts" | "transactions" | "done";

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface PlaidCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The Plaid cursor the current pagination loop began from; null for the start of the Item's history. */
  start: string | null;
  /** The Plaid cursor for the next page; once the pass is done, where the next pass begins. */
  next: string | null;
}

export interface PlaidConnectorOptions extends PlaidClientOptions {
  now?: () => Date;
  /** How the bank's descriptions are categorized. The generic profile when absent. */
  profile?: BankProfile;
  /**
   * The historical import's checkpoint, read when an incremental sync has
   * none of its own, so the first incremental pass carries on from where the
   * import ended instead of reading the whole history again.
   */
  historicalCheckpoint?: () => Promise<string | null>;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: PlaidClient;
}

const STEPS: Step[] = ["accounts", "transactions", "done"];
const plaidCursorOk = (c: unknown) => c === null || (typeof c === "string" && PLAID_CURSOR.test(c));

export function parsePlaidCursor(raw: string | null): PlaidCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as PlaidCursor;
  if (!c || (c.pass !== "historical" && c.pass !== "incremental") || !STEPS.includes(c.step) || !plaidCursorOk(c.start) || !plaidCursorOk(c.next)) {
    throw new Error("Plaid checkpoint is not in the expected shape");
  }
  return { pass: c.pass, step: c.step, start: c.start, next: c.next };
}

const isMutation = (error: unknown) => error instanceof PlaidApiError && error.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

export function plaidConnector(options: PlaidConnectorOptions): Connector {
  const client = options.client ?? plaidClient(options);
  const now = options.now ?? (() => new Date());

  /** Where an incremental pass with no checkpoint of its own begins: the end of the historical import, if it finished. */
  async function afterImport(): Promise<string | null> {
    const raw = options.historicalCheckpoint ? await options.historicalCheckpoint() : null;
    const imported = parsePlaidCursor(raw);
    return imported?.step === "done" ? imported.next : null;
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parsePlaidCursor(context.cursor);
    let cursor: PlaidCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : { pass: "historical", step: "accounts", start: null, next: null };
    } else if (saved?.pass === "incremental" && saved.step !== "done") {
      cursor = saved;
    } else {
      const from = saved ? saved.next : await afterImport();
      cursor = { pass: "incremental", step: "accounts", start: from, next: from };
    }
    if (cursor.step === "done") return;

    // Every pass reads the accounts, to tell card transactions from bank ones; only the accounts step stores them.
    const accounts = (await client.accounts()).accounts;
    const kinds: PlaidAccountKinds = plaidAccountKinds(accounts);
    if (cursor.step === "accounts") {
      const receivedAt = now().toISOString();
      cursor = { ...cursor, step: "transactions" };
      yield { events: accounts.flatMap((a) => plaidAccountEvent(a, receivedAt) ?? []), cursor: JSON.stringify(cursor) };
    }

    let restarts = 0;
    while (cursor.step === "transactions") {
      let page;
      try {
        page = await client.transactionsSync(cursor.next);
      } catch (error) {
        // Plaid's guidance: the data changed mid-loop, so start the loop again from the cursor it began with.
        // Pages already stored come round again as duplicates.
        if (!isMutation(error) || restarts >= PLAID_MUTATION_RESTARTS) throw error;
        restarts++;
        cursor = { ...cursor, next: cursor.start };
        continue;
      }
      const events = plaidSyncEvents(page, now().toISOString(), kinds, options.profile);
      // Plaid answers an Item whose transactions aren't ready yet with an empty cursor.
      const next = page.next_cursor || null;
      cursor = page.has_more ? { ...cursor, next } : { ...cursor, step: "done", start: next, next };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "plaid",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: PLAID_WRITES,
  };
}
