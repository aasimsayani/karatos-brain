import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { AFTERPAY_PAGE_SIZE, afterpayClient, type AfterpayClient, type AfterpayClientOptions } from "./client.js";
import { afterpayPaymentEvents, type AfterpayEvent } from "./normalize.js";

/**
 * Afterpay: a store's pay-over-time orders and their refunds, next to the
 * sale in the POS and the deposit in the bank.
 *
 * List Payments filters by when a payment was created, never by when it
 * last changed, and a payment keeps changing after that: it is captured,
 * refunded or voided later. So:
 *
 * - The historical import reads every payment created in the last five
 *   years, oldest first, a page at a time.
 * - Each later sync reads again every payment created in the last 60 days,
 *   or since the last sync finished if that is longer ago, and stores only
 *   what changed. A refund on a payment older than that isn't seen until
 *   the next historical import.
 *
 * Each page is one batch, and the checkpoint keeps the window and the
 * offset, so a sync that stops resumes at the same page.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and the client has no way to send it. */
export const AFTERPAY_WRITES: WriteAction[] = [{ integration: "afterpay", name: "refund_payment", description: "Refund an Afterpay order", kind: "update", approval: "each", dailyCap: 5 }];

const DAY_MS = 86_400_000;
/** Later syncs read payments created this many days back again, since they change after they are made. */
export const AFTERPAY_REVISIT_DAYS = 60;

/** The window being read: payments created from `from` to `to`, and how far in. */
export interface AfterpayPass {
  from: string;
  to: string;
  offset: number;
}

/** Serialized as the runSync checkpoint. */
export interface AfterpayCursor {
  /** The historical import finished. */
  done: boolean;
  /** The end of the last window a sync finished. */
  through: string | null;
  pass: AfterpayPass | null;
}

export interface AfterpayOptions extends AfterpayClientOptions {
  /** How far back the historical import reads. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AfterpayClient;
}

const MESSAGE = "Afterpay checkpoint is not in the expected shape";
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseAfterpayCursor(raw: string | null): AfterpayCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const passOk = r.pass === null || (isTime(p.from) && isTime(p.to) && p.from <= p.to && Number.isSafeInteger(p.offset) && (p.offset as number) >= 0);
  if (typeof r.done !== "boolean" || !(r.through === null || isTime(r.through)) || !passOk) throw new Error(MESSAGE);
  return { done: r.done, through: r.through as string | null, pass: r.pass === null ? null : { from: p.from as string, to: p.to as string, offset: p.offset as number } };
}

export function afterpayConnector(options: AfterpayOptions): Connector {
  const client = options.client ?? afterpayClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  async function* read(state: AfterpayCursor, start: () => AfterpayPass, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    let pass = state.pass ?? start();
    for (;;) {
      const page = await client.payments(pass);
      const receivedAt = now().toISOString();
      const rows = Array.isArray(page.results) ? page.results : [];
      const events: AfterpayEvent[] = rows.flatMap((row) => afterpayPaymentEvents(row, receivedAt).map((r) => r.event));
      const total = Number.isSafeInteger(page.totalResults) ? (page.totalResults as number) : Number.POSITIVE_INFINITY;
      const offset = pass.offset + rows.length;
      // A short page, or the total reached, ends the window; without a total, only a short page does.
      const last = rows.length < AFTERPAY_PAGE_SIZE || offset >= total;
      const cursor: AfterpayCursor = last ? { done: doneAtEnd, through: pass.to, pass: null } : { ...state, pass: { ...pass, offset } };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
      pass = { ...pass, offset };
    }
  }

  const fresh = (): AfterpayCursor => ({ done: false, through: null, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAfterpayCursor(context.cursor);
    if (saved?.done) return;
    yield* read(
      saved ?? fresh(),
      () => {
        const to = now();
        const from = new Date(to);
        from.setUTCFullYear(from.getUTCFullYear() - historyYears);
        return { from: from.toISOString(), to: to.toISOString(), offset: 0 };
      },
      true,
    );
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseAfterpayCursor(context.cursor) ?? fresh();
    yield* read(
      state,
      () => {
        const to = now();
        const revisit = new Date(to.getTime() - AFTERPAY_REVISIT_DAYS * DAY_MS).toISOString();
        return { from: state.through !== null && state.through < revisit ? state.through : revisit, to: to.toISOString(), offset: 0 };
      },
      state.done,
    );
  }

  return { source: "afterpay", historicalImport, incrementalSync, writes: AFTERPAY_WRITES };
}
