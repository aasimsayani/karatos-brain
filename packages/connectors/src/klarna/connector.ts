import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { klarnaClient, type KlarnaClient, type KlarnaClientOptions, type KlarnaEnvironment, type KlarnaRegion } from "./client.js";
import { klarnaPaymentReference, klarnaPayoutEvent, klarnaTransactionEvent, type KlarnaEvent } from "./normalize.js";

/**
 * Klarna: what Klarna paid the business for its buy-now-pay-later sales,
 * payout by payout, with each sale, return, fee and commission behind it,
 * so the deposit on the bank statement can be matched to the orders.
 *
 * - The historical import lists five years of payouts by payout date, a
 *   page at a time, and reads each payout's lines before the next payout.
 * - Each later sync lists the payouts made since a few days before the
 *   last pass started, so one Klarna publishes late is still read. One read
 *   again unchanged is a duplicate.
 *
 * Each payout, with its lines, is one batch and one checkpoint, which keeps
 * the pass's dates and how many payouts it has read, so a resumed pass goes
 * on from the next one.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no request to send them. */
export const KLARNA_WRITES: WriteAction[] = [
  { integration: "klarna", name: "capture_order", description: "Capture all or part of an authorized Klarna order, so the merchant is paid", kind: "update", approval: "each", dailyCap: 20 },
  { integration: "klarna", name: "refund_order", description: "Refund all or part of a captured Klarna order", kind: "update", approval: "each", dailyCap: 10 },
];

const DAY_MS = 86_400_000;
/** Each later pass lists payouts made from this long before the last one started. */
export const KLARNA_OVERLAP_MS = 3 * DAY_MS;

/** A pass under way: the payouts made from `start` to `end`, of which `offset` are read. */
export interface KlarnaPass {
  start: string;
  end: string;
  offset: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync starts. */
export interface KlarnaCursor {
  pass: KlarnaPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface KlarnaOptions extends Partial<Pick<KlarnaClientOptions, "fetch" | "sleep" | "retries" | "apiKey" | "username" | "password">> {
  region?: string | undefined;
  environment?: string | undefined;
  /** Payouts older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: KlarnaClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseKlarnaCursor(raw: string | null): KlarnaCursor | null {
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
  throw new Error("Klarna checkpoint is not in the expected shape");
}

export function klarnaConnector(options: KlarnaOptions): Connector {
  // The client checks the region and environment; a blank one is the default.
  const client =
    options.client ??
    klarnaClient({
      ...options,
      region: (options.region?.trim().toLowerCase() || undefined) as KlarnaRegion | undefined,
      environment: (options.environment?.trim().toLowerCase() || undefined) as KlarnaEnvironment | undefined,
    });
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Every line of one payout, page by page. */
  async function lines(paymentReference: string, receivedAt: string): Promise<KlarnaEvent[]> {
    const events: KlarnaEvent[] = [];
    for (let offset = 0; ; ) {
      const page = await client.transactions(paymentReference, offset);
      for (const t of page.items) events.push(klarnaTransactionEvent(t, { receivedAt, paymentReference, line: offset++ }));
      if (!page.more) return events;
    }
  }

  /** Reads a pass from where it stands to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(pass: KlarnaPass, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let offset = pass.offset;
    for (;;) {
      const page = await client.payouts({ start: pass.start, end: pass.end, offset });
      if (page.items.length === 0) {
        yield { events: [], cursor: JSON.stringify({ pass: null, done: doneAtEnd, nextFrom } satisfies KlarnaCursor) };
        return;
      }
      for (const [i, payout] of page.items.entries()) {
        const events = [klarnaPayoutEvent(payout, { receivedAt })];
        const reference = klarnaPaymentReference(payout);
        if (reference) events.push(...(await lines(reference, receivedAt)));
        offset++;
        const last = !page.more && i === page.items.length - 1;
        const cursor: KlarnaCursor = last ? { pass: null, done: doneAtEnd, nextFrom } : { pass: { ...pass, offset }, done, nextFrom };
        yield { events, cursor: JSON.stringify(cursor) };
      }
      if (!page.more) return;
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseKlarnaCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const end = at.toISOString();
    yield* walk({ start: from.toISOString(), end, offset: 0 }, false, true, new Date(at.getTime() - KLARNA_OVERLAP_MS).toISOString(), end);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseKlarnaCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const start = saved?.nextFrom ?? new Date(at.getTime() - KLARNA_OVERLAP_MS).toISOString();
    const done = saved?.done ?? false;
    yield* walk({ start, end: at.toISOString(), offset: 0 }, done, done, new Date(at.getTime() - KLARNA_OVERLAP_MS).toISOString(), at.toISOString());
  }

  return { source: "klarna", historicalImport, incrementalSync, writes: KLARNA_WRITES };
}
