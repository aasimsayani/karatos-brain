import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { rampClient, rampListUrl, type RampClient, type RampClientOptions, type RampEnvironment, type RampPage } from "./client.js";
import { rampTransactionEvent } from "./normalize.js";

/**
 * Ramp: the business's company card transactions, each with its category,
 * GL account, receipt and approval state, so month-end takes less chasing.
 *
 * - The historical import lists five years of transactions by when they
 *   were made, oldest first, a page at a time.
 * - Each later sync lists the transactions Ramp says changed after a day
 *   before the last pass started, so a receipt, memo, category or
 *   settlement added since is read again. One read again unchanged is a
 *   duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps Ramp's link to the
 * next page, so a resumed pass goes on from there. Ramp can send webhooks,
 * but the connector polls so it needs no public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, the client has no request to send them, and the app is never given a write scope. */
export const RAMP_WRITES: WriteAction[] = [
  { integration: "ramp", name: "set_transaction_memo", description: "Add a memo to a Ramp card transaction", kind: "update", approval: "each", dailyCap: 50 },
  { integration: "ramp", name: "set_transaction_category", description: "Code a Ramp card transaction to a GL account or category", kind: "update", approval: "each", dailyCap: 50 },
];

const DAY_MS = 86_400_000;
/** Each later pass lists what changed after this long before the last one started. */
export const RAMP_OVERLAP_MS = DAY_MS;

/** Serialized as the runSync checkpoint. `next` is Ramp's link to the pass's next page, or null between passes; `nextFrom` is where the next later sync starts. */
export interface RampCursor {
  next: string | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface RampOptions extends Partial<Pick<RampClientOptions, "fetch" | "sleep" | "retries" | "environment">> {
  clientId: string;
  clientSecret: string;
  /** Transactions older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: RampClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseRampCursor(raw: string | null, baseUrl: string): RampCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  if (r && typeof r.done === "boolean" && isTime(r.nextFrom) && (r.next === null || rampListUrl(r.next, baseUrl))) return { next: r.next as string | null, done: r.done, nextFrom: r.nextFrom };
  throw new Error("Ramp checkpoint is not in the expected shape");
}

export function rampConnector(options: RampOptions): Connector {
  // The client checks the environment; a blank one is production.
  const client = options.client ?? rampClient({ ...options, environment: (options.environment?.trim() || undefined) as RampEnvironment | undefined });
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass from its first page to its last. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(first: () => Promise<RampPage>, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let page = await first();
    for (;;) {
      const events = page.transactions.map((t) => rampTransactionEvent(t, { receivedAt }));
      const cursor: RampCursor = page.next ? { next: page.next, done, nextFrom } : { next: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
      if (!page.next) return;
      page = await client.page(page.next);
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRampCursor(context.cursor, client.baseUrl);
    if (saved?.done) return;
    if (saved?.next) return yield* walk(() => client.page(saved.next!), false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const toDate = at.toISOString();
    yield* walk(() => client.transactions({ fromDate: from.toISOString(), toDate }), false, true, new Date(at.getTime() - RAMP_OVERLAP_MS).toISOString(), toDate);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseRampCursor(context.cursor, client.baseUrl);
    const at = now();
    if (saved?.next) return yield* walk(() => client.page(saved.next!), saved.done, saved.done, saved.nextFrom, at.toISOString());
    const updatedAfter = saved?.nextFrom ?? new Date(at.getTime() - RAMP_OVERLAP_MS).toISOString();
    const done = saved?.done ?? false;
    yield* walk(() => client.transactions({ updatedAfter }), done, done, new Date(at.getTime() - RAMP_OVERLAP_MS).toISOString(), at.toISOString());
  }

  return { source: "ramp", historicalImport, incrementalSync, writes: RAMP_WRITES };
}
