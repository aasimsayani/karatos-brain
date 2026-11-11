import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { REPAIRSHOPR_LISTS, repairShoprClient, type RepairShoprClient, type RepairShoprClientOptions, type RepairShoprList } from "./client.js";
import { repairShoprEvent } from "./normalize.js";

/**
 * RepairShopr: a repair shop's jobs, the quotes for them and what they were
 * billed, so work can be followed from intake to payment.
 *
 * - The historical import reads five years of tickets and invoices by when
 *   they last changed, and the estimates made in that time.
 * - Each later sync reads the tickets and invoices changed since an hour
 *   before the last pass started, and the estimates made in the 60 days
 *   before that, since RepairShopr can't list estimates by when they
 *   changed and a quote is approved or declined within weeks. One read
 *   again unchanged is a duplicate.
 *
 * A pass reads one list after another, a page at a time. Each page is one
 * batch and one checkpoint, which keeps the list and the next page, so a
 * resumed pass goes on from there.
 */

/** None: tickets, estimates and invoices are the shop's to change. */
export const REPAIRSHOPR_WRITES: WriteAction[] = [];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Each later pass reads what changed from this long before the last one started. */
export const REPAIRSHOPR_OVERLAP_MS = HOUR_MS;
/** Each later pass reads the estimates made from this long before that. */
export const REPAIRSHOPR_ESTIMATE_LOOKBACK_MS = 60 * DAY_MS;

/** A pass under way: the list it is on, and the next page of it. */
export interface RepairShoprPass {
  list: RepairShoprList;
  page: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `from` is what the pass reads from; `nextFrom` is where the next later sync starts. */
export interface RepairShoprCursor {
  pass: RepairShoprPass | null;
  /** The historical import finished. */
  done: boolean;
  from: string;
  nextFrom: string;
}

export interface RepairShoprOptions extends Partial<Pick<RepairShoprClientOptions, "fetch" | "sleep" | "retries">> {
  apiToken: string;
  subdomain: string;
  /** Records older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: RepairShoprClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseRepairShoprCursor(raw: string | null): RepairShoprCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  // Anything but an object reads as a checkpoint without the fields asked for.
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const pass = (REPAIRSHOPR_LISTS as readonly unknown[]).includes(p.list) && Number.isSafeInteger(p.page) && (p.page as number) >= 1 ? { list: p.list as RepairShoprList, page: p.page as number } : null;
  if (typeof r.done === "boolean" && isTime(r.from) && isTime(r.nextFrom) && (r.pass === null || pass)) return { pass, done: r.done, from: r.from, nextFrom: r.nextFrom };
  throw new Error("RepairShopr checkpoint is not in the expected shape");
}

export function repairShoprConnector(options: RepairShoprOptions): Connector {
  const client = options.client ?? repairShoprClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass from where it stands to its end. `cursor.done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(at: RepairShoprPass, since: (list: RepairShoprList) => string, cursor: Omit<RepairShoprCursor, "pass">, doneAtEnd: boolean, receivedAt: string): AsyncIterable<SourceBatch> {
    for (let i = REPAIRSHOPR_LISTS.indexOf(at.list), page = at.page; i < REPAIRSHOPR_LISTS.length; i++, page = 1) {
      const list = REPAIRSHOPR_LISTS[i]!;
      for (; ; page++) {
        const result = await client.list({ list, since: since(list), page });
        const events = result.records.map((r) => repairShoprEvent(list, r, { receivedAt }));
        const next: RepairShoprPass | null = result.more ? { list, page: page + 1 } : i + 1 < REPAIRSHOPR_LISTS.length ? { list: REPAIRSHOPR_LISTS[i + 1]!, page: 1 } : null;
        const saved: RepairShoprCursor = next ? { ...cursor, pass: next } : { ...cursor, pass: null, done: doneAtEnd };
        yield { events, cursor: JSON.stringify(saved) };
        if (!result.more) break;
      }
    }
  }

  /** What a later pass reads from: the time for tickets and invoices, and the lookback before it for estimates. */
  const changedSince = (from: string) => (list: RepairShoprList) => (list === "estimates" ? new Date(Date.parse(from) - REPAIRSHOPR_ESTIMATE_LOOKBACK_MS).toISOString() : from);

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRepairShoprCursor(context.cursor);
    if (saved?.done) return;
    const at = now();
    const receivedAt = at.toISOString();
    if (saved?.pass) return yield* walk(saved.pass, () => saved.from, { done: false, from: saved.from, nextFrom: saved.nextFrom }, true, receivedAt);
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const start = from.toISOString();
    yield* walk({ list: REPAIRSHOPR_LISTS[0], page: 1 }, () => start, { done: false, from: start, nextFrom: new Date(at.getTime() - REPAIRSHOPR_OVERLAP_MS).toISOString() }, true, receivedAt);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRepairShoprCursor(context.cursor);
    const at = now();
    const receivedAt = at.toISOString();
    if (saved?.pass) return yield* walk(saved.pass, changedSince(saved.from), { done: saved.done, from: saved.from, nextFrom: saved.nextFrom }, saved.done, receivedAt);
    const from = saved?.nextFrom ?? new Date(at.getTime() - REPAIRSHOPR_OVERLAP_MS).toISOString();
    const done = saved?.done ?? false;
    yield* walk({ list: REPAIRSHOPR_LISTS[0], page: 1 }, changedSince(from), { done, from, nextFrom: new Date(at.getTime() - REPAIRSHOPR_OVERLAP_MS).toISOString() }, done, receivedAt);
  }

  return { source: "repairshopr", historicalImport, incrementalSync, writes: REPAIRSHOPR_WRITES };
}
