import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { acumaticaClient, type AcumaticaClient, type AcumaticaClientOptions, type AcumaticaEntity } from "./client.js";
import { acumaticaItemEvents, acumaticaOrderEvent, type AcumaticaContext, type AcumaticaEvent } from "./normalize.js";

/**
 * Acumatica JewelShop: a wholesaler's or manufacturer's stock items, what
 * each warehouse has of them, and its sales orders.
 *
 * Every pass reads all stock items, since what a warehouse has on hand can
 * change without an item's LastModified moving, then the sales orders
 * modified in its window. The historical import's window reaches back five
 * years; each later sync's starts a day before the last one ended, so an
 * order a page shift skipped is read again. One read again unchanged is a
 * duplicate.
 *
 * A pass reads records modified up to a time fixed when it starts, so a
 * record changed during the pass waits for the next one. Each page is one
 * batch and one checkpoint, which keeps the pass's times, its step and how
 * many records of it are read, so a resumed pass goes on from there.
 *
 * JewelShop's memo and consignment screens aren't on Acumatica's Default
 * endpoint, so they aren't read yet.
 */

/** None until access is confirmed: the user's role can only view. */
export const ACUMATICA_WRITES: WriteAction[] = [];

const DAY_MS = 86_400_000;
/** Each later pass reads orders modified from this long before the last one ended. */
export const ACUMATICA_OVERLAP_MS = DAY_MS;
const STEPS = ["StockItem", "SalesOrder"] as const satisfies readonly AcumaticaEntity[];

/** A pass under way: orders modified after `from` and up to `to`, and how many records of `step` it has read. */
export interface AcumaticaPass {
  from: string;
  to: string;
  step: AcumaticaEntity;
  skip: number;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync's orders start. */
export interface AcumaticaCursor {
  pass: AcumaticaPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface AcumaticaOptions extends Omit<AcumaticaClientOptions, "now"> {
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Orders modified longer ago than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: AcumaticaClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseAcumaticaCursor(raw: string | null): AcumaticaCursor | null {
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
  const pass = isTime(p.from) && isTime(p.to) && p.from <= p.to && STEPS.includes(p.step as AcumaticaEntity) && Number.isSafeInteger(p.skip) && (p.skip as number) >= 0 ? { from: p.from, to: p.to, step: p.step as AcumaticaEntity, skip: p.skip as number } : null;
  if (typeof r.done === "boolean" && isTime(r.nextFrom) && (r.pass === null || pass)) return { pass, done: r.done, nextFrom: r.nextFrom };
  throw new Error("Acumatica checkpoint is not in the expected shape");
}

export function acumaticaConnector(options: AcumaticaOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const now = options.now ?? (() => new Date());
  const client = options.client ?? acumaticaClient(options);
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  const eventsOf = (step: AcumaticaEntity, records: unknown[], ctx: AcumaticaContext): AcumaticaEvent[] => (step === "StockItem" ? records.flatMap((r) => acumaticaItemEvents(r, ctx)) : records.map((r) => acumaticaOrderEvent(r, ctx)));

  /** Reads a pass from where it stands to its end, then signs out. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(start: AcumaticaPass, done: boolean, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const ctx: AcumaticaContext = { receivedAt: now().toISOString(), customerKey };
    const nextFrom = new Date(Date.parse(start.to) - ACUMATICA_OVERLAP_MS).toISOString();
    let pass = start;
    try {
      for (let last = false; !last; ) {
        // Stock items are read whole; orders by when they were modified.
        const result = await client.list(pass.step, { from: pass.step === "StockItem" ? null : pass.from, to: pass.to, skip: pass.skip });
        const events = eventsOf(pass.step, result.records, ctx);
        last = !result.more && pass.step === "SalesOrder";
        pass = result.more ? { ...pass, skip: pass.skip + result.records.length } : { ...pass, step: "SalesOrder", skip: 0 };
        const cursor: AcumaticaCursor = last ? { pass: null, done: doneAtEnd, nextFrom } : { pass, done, nextFrom };
        yield { events, cursor: JSON.stringify(cursor) };
      }
    } finally {
      await client.signOut();
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAcumaticaCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true);
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ from: from.toISOString(), to: at.toISOString(), step: "StockItem", skip: 0 }, false, true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAcumaticaCursor(context.cursor);
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done);
    const at = now();
    const done = saved?.done ?? false;
    yield* walk({ from: saved?.nextFrom ?? new Date(at.getTime() - ACUMATICA_OVERLAP_MS).toISOString(), to: at.toISOString(), step: "StockItem", skip: 0 }, done, done);
  }

  return { source: "acumatica_jewelshop", historicalImport, incrementalSync, writes: ACUMATICA_WRITES };
}
