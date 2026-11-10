import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { TAXJAR_PROVIDER, TaxjarConfigError, taxjarClient, type TaxjarClient, type TaxjarClientOptions, type TaxjarKind } from "./client.js";
import { taxjarNexusEvent, taxjarTransactionEvent, type TaxjarEvent } from "./normalize.js";

/**
 * TaxJar: the sales tax on every sale and refund the store records in
 * TaxJar, and the states it has nexus in, for finance and compliance.
 *
 * TaxJar lists transactions by the day they were recorded, as ids, one
 * source (provider) at a time, and keeps no change time. So a pass walks
 * each provider's orders and then its refunds through the days in spans of
 * 31, reads each listed transaction, and ends by reading the nexus regions.
 *
 * - The historical import covers five years by default.
 * - Each later sync covers the last 31 days again, since a transaction can
 *   be recorded late with an earlier day, or changed; an unchanged one is a
 *   duplicate.
 *
 * Each 100 transactions read are one batch and one checkpoint, which keeps
 * the pass's span, the step, the span of days being read and how many of
 * its ids were read, so a resumed pass goes on from there.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const TAXJAR_WRITES: WriteAction[] = [
  { integration: "taxjar", name: "create_order_transaction", description: "Record a sale in TaxJar for sales tax reporting" },
  { integration: "taxjar", name: "create_refund_transaction", description: "Record a refund in TaxJar for sales tax reporting" },
];

const DAY_MS = 86_400_000;
/** Days of transactions listed at a time. */
export const TAXJAR_SPAN_DAYS = 31;
/** Transactions read per batch and checkpoint. */
export const TAXJAR_BATCH = 100;
/** Each later sync reads this many days again. */
export const TAXJAR_LOOKBACK_DAYS = 31;
const KINDS: readonly TaxjarKind[] = ["orders", "refunds"];

/** Where a TaxJar pass stands: its first and last day, the step (provider and kind, or the nexus read), the span's first day and how many of its ids were read. */
export interface TaxjarPass {
  from: string;
  until: string;
  step: number;
  spanFrom: string;
  offset: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `done` says the import finished. */
export interface TaxjarCursor {
  pass: TaxjarPass | null;
  done: boolean;
}

export interface TaxjarOptions extends Partial<Pick<TaxjarClientOptions, "fetch" | "sleep" | "retries" | "environment">> {
  apiToken: string;
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Where the store's transactions were recorded in TaxJar, such as api or shopify. Defaults to api. */
  providers?: string[];
  /** Transactions recorded earlier than this many years ago are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: TaxjarClient;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
/** A day as TaxJar's filters take it. */
const slashed = (day: string) => day.replace(/-/g, "/");

export function parseTaxjarCursor(raw: string | null): TaxjarCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  const p = r?.pass;
  if (r && typeof r.done === "boolean" && p === null) return { pass: null, done: r.done };
  if (r && typeof r.done === "boolean" && typeof p === "object" && p !== null && !Array.isArray(p)) {
    const q = p as Record<string, unknown>;
    if (isDay(q.from) && isDay(q.until) && whole(q.step) && isDay(q.spanFrom) && whole(q.offset)) {
      return { pass: { from: q.from, until: q.until, step: q.step, spanFrom: q.spanFrom, offset: q.offset }, done: r.done };
    }
  }
  throw new Error("TaxJar checkpoint is not in the expected shape");
}

export function taxjarConnector(options: TaxjarOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const providers = options.providers?.length ? [...new Set(options.providers)] : ["api"];
  for (const p of providers) if (!TAXJAR_PROVIDER.test(p)) throw new TaxjarConfigError("TAXJAR_PROVIDERS must be lowercase source names such as api or shopify");
  const client = options.client ?? taxjarClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  /** Orders then refunds for each provider, then the nexus read. */
  const steps = providers.flatMap((provider) => KINDS.map((kind) => ({ provider, kind })));
  const nexusStep = steps.length;

  async function* walk(pass: TaxjarPass, finish: TaxjarCursor, receivedAt: string): AsyncIterable<SourceBatch> {
    if (pass.step > nexusStep) throw new Error("TaxJar checkpoint is not in the expected shape");
    let { step, spanFrom, offset } = pass;
    const at = (where: Pick<TaxjarPass, "step" | "spanFrom" | "offset">): string => JSON.stringify({ pass: { from: pass.from, until: pass.until, ...where }, done: false } satisfies TaxjarCursor);
    for (; step < nexusStep; step++, spanFrom = pass.from, offset = 0) {
      const { provider, kind } = steps[step]!;
      for (; spanFrom <= pass.until; spanFrom = addDays(spanTo(spanFrom, pass.until), 1), offset = 0) {
        const to = spanTo(spanFrom, pass.until);
        const ids = [...new Set(await client.list(kind, { from: slashed(spanFrom), to: slashed(to), provider }))].sort();
        while (offset < ids.length) {
          const chunk = ids.slice(offset, offset + TAXJAR_BATCH);
          const events: TaxjarEvent[] = [];
          for (const id of chunk) {
            const record = await client.show(kind, id, provider);
            // Deleted since it was listed.
            if (record !== null) events.push(taxjarTransactionEvent(record, kind, { customerKey, provider, receivedAt }).event);
          }
          offset += chunk.length;
          // Where the next read starts: later in this span, the next span, or the next step.
          const cursor = offset < ids.length ? at({ step, spanFrom, offset }) : to < pass.until ? at({ step, spanFrom: addDays(to, 1), offset: 0 }) : at({ step: step + 1, spanFrom: pass.from, offset: 0 });
          yield { events, cursor };
        }
      }
    }
    yield { events: [taxjarNexusEvent(await client.nexusRegions(), receivedAt)], cursor: JSON.stringify(finish) };
  }

  const spanTo = (from: string, until: string) => {
    const to = addDays(from, TAXJAR_SPAN_DAYS - 1);
    return to < until ? to : until;
  };

  function newPass(fromMs: number, untilMs: number): TaxjarPass {
    const from = dayOf(fromMs);
    return { from, until: dayOf(untilMs), step: 0, spanFrom: from, offset: 0 };
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTaxjarCursor(context.cursor);
    if (saved?.done) return;
    const at = now();
    const start = new Date(at.getTime());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    yield* walk(saved?.pass ?? newPass(start.getTime(), at.getTime()), { pass: null, done: true }, at.toISOString());
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseTaxjarCursor(context.cursor);
    const at = now();
    yield* walk(saved?.pass ?? newPass(at.getTime() - (TAXJAR_LOOKBACK_DAYS - 1) * DAY_MS, at.getTime()), { pass: null, done: false }, at.toISOString());
  }

  return { source: "taxjar", historicalImport, incrementalSync, writes: TAXJAR_WRITES };
}
