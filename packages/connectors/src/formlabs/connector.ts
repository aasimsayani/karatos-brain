import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { formlabsClient, type FormlabsClient, type FormlabsClientOptions } from "./client.js";
import { formlabsPrintEvent } from "./normalize.js";

/**
 * Formlabs: the print runs a workshop's Formlabs printers made, so casting
 * wax and resin models can be followed from the queue to a finished print.
 *
 * - The historical import lists a year of print runs by when they were
 *   made, a page at a time.
 * - Each later sync lists the runs made from three days before the last
 *   pass ended, so a run still printing then is read again once it
 *   finishes. One read again unchanged is a duplicate.
 *
 * A pass lists runs between two fixed times, so new runs don't shift its
 * pages. Each page is one batch and one checkpoint, which keeps the pass's
 * times and the next page, so a resumed pass goes on from there.
 */

/** None: printers and their groups are the workshop's to change. */
export const FORMLABS_WRITES: WriteAction[] = [];

const DAY_MS = 86_400_000;
/** Each later pass lists the runs made from this long before the last one ended. */
export const FORMLABS_OVERLAP_MS = 3 * DAY_MS;

/** A pass under way: the runs made after `from` and before `to`, and the next page of them. */
export interface FormlabsPass {
  from: string;
  to: string;
  page: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync starts. */
export interface FormlabsCursor {
  pass: FormlabsPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface FormlabsOptions extends Partial<Pick<FormlabsClientOptions, "fetch" | "sleep" | "retries">> {
  clientId: string;
  clientSecret: string;
  /** Runs older than this many years are skipped. Defaults to 1. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: FormlabsClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseFormlabsCursor(raw: string | null): FormlabsCursor | null {
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
  const pass = isTime(p.from) && isTime(p.to) && p.from <= p.to && Number.isSafeInteger(p.page) && (p.page as number) >= 1 ? { from: p.from, to: p.to, page: p.page as number } : null;
  if (typeof r.done === "boolean" && isTime(r.nextFrom) && (r.pass === null || pass)) return { pass, done: r.done, nextFrom: r.nextFrom };
  throw new Error("Formlabs checkpoint is not in the expected shape");
}

export function formlabsConnector(options: FormlabsOptions): Connector {
  const now = options.now ?? (() => new Date());
  const client = options.client ?? formlabsClient({ ...options, now });
  const historyYears = options.historyYears ?? 1;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass from its page to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: FormlabsPass, done: boolean, doneAtEnd: boolean, nextFrom: string): AsyncIterable<SourceBatch> {
    const receivedAt = now().toISOString();
    for (let page = pass.page; ; page++) {
      const result = await client.prints({ from: pass.from, to: pass.to }, page);
      const events = result.records.map((r) => formlabsPrintEvent(r, { receivedAt }));
      const cursor: FormlabsCursor = result.more ? { pass: { ...pass, page: page + 1 }, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
      if (!result.more) return;
    }
  }

  /** Where the next later sync starts: three days before this pass ends. */
  const overlap = (to: string) => new Date(Date.parse(to) - FORMLABS_OVERLAP_MS).toISOString();

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseFormlabsCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom);
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const to = at.toISOString();
    yield* walk({ from: from.toISOString(), to, page: 1 }, false, true, overlap(to));
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseFormlabsCursor(context.cursor);
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom);
    const to = now().toISOString();
    const done = saved?.done ?? false;
    yield* walk({ from: saved?.nextFrom ?? overlap(to), to, page: 1 }, done, done, overlap(to));
  }

  return { source: "formlabs", historicalImport, incrementalSync, writes: FORMLABS_WRITES };
}
