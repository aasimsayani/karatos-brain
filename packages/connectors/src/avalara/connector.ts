import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { AVALARA_PAGE_SIZE, AvalaraApiError, avalaraClient, type AvalaraClient, type AvalaraClientOptions } from "./client.js";
import { avalaraTime, avalaraTransactionEvent, type AvalaraEvent } from "./normalize.js";

/**
 * Avalara AvaTax: the sales tax charged on every sale, return and purchase
 * the store records in AvaTax, by jurisdiction, for finance and
 * compliance.
 *
 * - The historical import reads every transaction dated in the history
 *   window (five years by default), by id, 1,000 a page, and records the
 *   last id it read, so a resumed import carries on.
 * - Each later sync reads the transactions changed since the last pass
 *   started (less five minutes, for changes still being saved), in order of
 *   change. A pass resumes from the last change time it read and how many
 *   transactions it read at that time.
 *
 * Each page is one batch and one checkpoint. Lines and per-line tax details
 * aren't read: the jurisdiction summary is what tax returns are filed by.
 * AvaTax has no webhooks for transactions, so the sync polls.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const AVALARA_WRITES: WriteAction[] = [
  { integration: "avalara", name: "create_transaction", description: "Record a transaction in AvaTax" },
  { integration: "avalara", name: "commit_transaction", description: "Commit an AvaTax transaction for reporting" },
  { integration: "avalara", name: "void_transaction", description: "Void an AvaTax transaction" },
  { integration: "avalara", name: "adjust_transaction", description: "Adjust an AvaTax transaction" },
  { integration: "avalara", name: "refund_transaction", description: "Refund an AvaTax transaction" },
];

const MINUTE = 60_000;
const DAY_MS = 86_400_000;
/** Later syncs start this much before the last pass did, for changes still being saved when it ran. */
export const AVALARA_OVERLAP_MS = 5 * MINUTE;
/** With no checkpoint, the first later sync looks this far back. */
export const AVALARA_FIRST_LOOKBACK_DAYS = 7;

/** Where an AvaTax sync stands. Serialized as the runSync checkpoint. */
export type AvalaraCursor =
  /** The import: the last transaction id read, and whether it read everything. */
  | { afterId: number; done: boolean }
  /** A later sync: the change time it has read up to, how many it read at that time, and where the next pass starts (null between passes). */
  | { modifiedFrom: string; skip: number; nextFrom: string | null };

export interface AvalaraOptions extends Partial<Pick<AvalaraClientOptions, "fetch" | "sleep" | "retries">> {
  accountId: string;
  environment: AvalaraClientOptions["environment"];
  licenseKey: string;
  /** The company to read. Empty means the account's default company. */
  companyCode?: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Transactions dated earlier than this many years ago are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AvalaraClient;
}

const ISO = (v: unknown): v is string => typeof v === "string" && avalaraTime(v) === v;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export function parseAvalaraCursor(raw: string | null, mode: "historical" | "incremental"): AvalaraCursor | null {
  if (raw === null) return null;
  let c: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    c = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    c = null;
  }
  if (c && mode === "historical" && whole(c.afterId) && typeof c.done === "boolean") return { afterId: c.afterId, done: c.done };
  if (c && mode === "incremental" && ISO(c.modifiedFrom) && whole(c.skip) && (c.nextFrom === null || ISO(c.nextFrom))) return { modifiedFrom: c.modifiedFrom, skip: c.skip, nextFrom: c.nextFrom };
  throw new Error("Avalara checkpoint is not in the expected shape");
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};
const iso = (ms: number) => new Date(ms).toISOString();

export function avalaraConnector(options: AvalaraOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const client = options.client ?? avalaraClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const configured = options.companyCode?.trim() || undefined;

  async function start(at: number) {
    await client.ping();
    const company = await client.company(configured);
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    return { companyCode: company.companyCode, fromDay: from.toISOString().slice(0, 10), receivedAt: iso(at) };
  }

  const read = (rows: unknown[], companyCode: string, receivedAt: string): AvalaraEvent[] =>
    rows.map((row) => avalaraTransactionEvent(row, { customerKey, accountId: options.accountId, companyCode, receivedAt }).event);

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAvalaraCursor(context.cursor, "historical") as { afterId: number; done: boolean } | null;
    if (saved?.done) return;
    const { companyCode, fromDay, receivedAt } = await start(now().getTime());
    let afterId = saved?.afterId ?? 0;
    for (;;) {
      const rows = await client.transactions(companyCode, { fromDay, afterId });
      const ids = rows.map((r) => (r as { id?: unknown } | null)?.id).filter((id): id is number => whole(id) && id > afterId);
      if (rows.length > 0 && ids.length === 0) throw new AvalaraApiError("AvaTax answered a page of transactions with no id after the last one read", 200);
      if (ids.length) afterId = Math.max(...ids);
      const done = rows.length < AVALARA_PAGE_SIZE;
      yield { events: read(rows, companyCode, receivedAt), cursor: JSON.stringify({ afterId, done } satisfies AvalaraCursor) };
      if (done) return;
    }
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAvalaraCursor(context.cursor, "incremental") as { modifiedFrom: string; skip: number; nextFrom: string | null } | null;
    const at = now().getTime();
    const { companyCode, fromDay, receivedAt } = await start(at);
    // A pass resumed part way keeps where it said the next pass starts.
    const nextFrom = saved?.nextFrom ?? iso(at - AVALARA_OVERLAP_MS);
    let modifiedFrom = saved?.modifiedFrom ?? iso(at - AVALARA_FIRST_LOOKBACK_DAYS * DAY_MS);
    let skip = saved?.skip ?? 0;
    for (;;) {
      const rows = await client.transactions(companyCode, { fromDay, modifiedFrom, skip });
      for (const row of rows) {
        const m = avalaraTime((row as { modifiedDate?: unknown } | null)?.modifiedDate);
        // Rows come in order of change; count those at the time read up to, so the next page skips them.
        if (m && m > modifiedFrom) {
          modifiedFrom = m;
          skip = 1;
        } else {
          skip++;
        }
      }
      const done = rows.length < AVALARA_PAGE_SIZE;
      const cursor: AvalaraCursor = done ? { modifiedFrom: nextFrom, skip: 0, nextFrom: null } : { modifiedFrom, skip, nextFrom };
      yield { events: read(rows, companyCode, receivedAt), cursor: JSON.stringify(cursor) };
      if (done) return;
    }
  }

  return { source: "avalara", historicalImport, incrementalSync, writes: AVALARA_WRITES };
}
