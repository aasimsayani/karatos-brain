import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { AURORA_PAGE_SIZE, auroraClient, type AuroraClient, type AuroraClientOptions, type AuroraEnvironment } from "./client.js";
import { auroraBatchEvent, auroraTransactionEvent, type AuroraEvent } from "./normalize.js";

/**
 * Aurora Payments (Flute): the card and ACH settlement batches a jeweler's
 * processor paid out, with each transaction in them, so a deposit on the
 * bank statement can be matched to the sales, refunds and fees behind it.
 *
 * - The historical import lists five years of settlement batches by when
 *   they were batched, oldest first, and reads each batch's transactions
 *   before the next batch.
 * - Each later sync lists the batches from a week before the last pass
 *   started, so a batch that was open then is read again once it settles.
 *   One read again unchanged is a duplicate.
 *
 * Each settlement batch, with its transactions, is one batch and one
 * checkpoint, which keeps the pass's dates and how many batches it has
 * read, so a resumed pass goes on from the next one.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no request to send them. */
export const AURORA_WRITES: WriteAction[] = [
  { integration: "aurora_payments", name: "refund_transaction", description: "Refund all or part of a settled Aurora Payments card or ACH transaction", kind: "update", approval: "each", dailyCap: 10 },
  { integration: "aurora_payments", name: "void_transaction", description: "Void an Aurora Payments transaction before its batch settles", kind: "update", approval: "each", dailyCap: 10 },
];

const DAY_MS = 86_400_000;
/** Each later pass lists the batches from this long before the last one started. */
export const AURORA_OVERLAP_MS = 7 * DAY_MS;

/** A pass under way: the batches dated from `start` to `end`, of which `offset` are read. */
export interface AuroraPass {
  start: string;
  end: string;
  offset: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync starts. */
export interface AuroraCursor {
  pass: AuroraPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface AuroraOptions extends Partial<Pick<AuroraClientOptions, "fetch" | "sleep" | "retries">> {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  environment?: string | undefined;
  /** Batches older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AuroraClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseAuroraCursor(raw: string | null): AuroraCursor | null {
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
  const pass = isTime(p.start) && isTime(p.end) && p.start <= p.end && Number.isSafeInteger(p.offset) && (p.offset as number) >= 0 ? { start: p.start, end: p.end, offset: p.offset as number } : null;
  if (typeof r.done === "boolean" && isTime(r.nextFrom) && (r.pass === null || pass)) return { pass, done: r.done, nextFrom: r.nextFrom };
  throw new Error("Aurora Payments checkpoint is not in the expected shape");
}

export function auroraConnector(options: AuroraOptions): Connector {
  // The client checks the environment; a blank one is production.
  const client = options.client ?? auroraClient({ ...options, clientId: options.clientId ?? "", clientSecret: options.clientSecret ?? "", environment: (options.environment?.trim().toLowerCase() || undefined) as AuroraEnvironment | undefined, ...(options.now ? { now: options.now } : {}) });
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Every transaction in one batch, page by page. */
  async function transactions(batchId: string, receivedAt: string): Promise<AuroraEvent[]> {
    const events: AuroraEvent[] = [];
    for (let page = 0; ; page++) {
      const result = await client.transactions(batchId, page);
      for (const t of result.items) events.push(auroraTransactionEvent(t, { receivedAt, batchId }));
      if (!result.more) return events;
    }
  }

  /** Reads a pass from where it stands to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: AuroraPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let offset = pass.offset;
    for (let page = Math.floor(offset / AURORA_PAGE_SIZE); ; page++) {
      const result = await client.batches({ from: pass.start, to: pass.end }, page);
      // Those on this page the pass has read already.
      const items = result.items.slice(offset - page * AURORA_PAGE_SIZE);
      if (items.length === 0 && !result.more) {
        yield { events: [], cursor: JSON.stringify({ pass: null, done: doneAtEnd, nextFrom } satisfies AuroraCursor) };
        return;
      }
      for (const [i, batch] of items.entries()) {
        const event = auroraBatchEvent(batch, { receivedAt });
        const events = [event];
        const id = event.payload.payoutId;
        // A batch dead-lettered for its time still has its transactions read, when its ID reads.
        if (typeof id === "string") events.push(...(await transactions(id.slice("aurora:batch:".length), receivedAt)));
        offset++;
        const last = !result.more && i === items.length - 1;
        const cursor: AuroraCursor = last ? { pass: null, done: doneAtEnd, nextFrom } : { pass: { ...pass, offset }, done, nextFrom };
        yield { events, cursor: JSON.stringify(cursor) };
      }
      if (!result.more) return;
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAuroraCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const end = at.toISOString();
    yield* walk({ start: from.toISOString(), end, offset: 0 }, false, true, new Date(at.getTime() - AURORA_OVERLAP_MS).toISOString(), end);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAuroraCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const start = saved?.nextFrom ?? new Date(at.getTime() - AURORA_OVERLAP_MS).toISOString();
    const done = saved?.done ?? false;
    yield* walk({ start, end: at.toISOString(), offset: 0 }, done, done, new Date(at.getTime() - AURORA_OVERLAP_MS).toISOString(), at.toISOString());
  }

  return { source: "aurora_payments", historicalImport, incrementalSync, writes: AURORA_WRITES };
}
