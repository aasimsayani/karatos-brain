import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { checkCustomerRefKey } from "../custom_forms/customer.js";
import { squarespaceClient, type SquarespaceClient, type SquarespaceClientOptions, type SquarespaceList } from "./client.js";
import { squarespaceOrderEvent, squarespaceProductEvent, squarespaceStockEvent, type SquarespaceContext, type SquarespaceEvent } from "./normalize.js";

/**
 * Squarespace Commerce: a store's products, stock and orders.
 *
 * Every pass reads the whole catalog, then every stock line, then the
 * orders modified in its window, 50 to a page. The historical import's
 * window reaches back five years; each later sync's starts a day before the
 * last one ended. A pass reads orders modified up to a time fixed when it
 * starts. Each page is one batch and one checkpoint, which keeps the pass's
 * times, its step and the next page's cursor, so a resumed pass goes on
 * from there.
 */

/** Declared and turned off: the write gate refuses both while writes are off. */
export const SQUARESPACE_WRITES: WriteAction[] = [
  { integration: "squarespace", name: "update_stock", description: "Set a Squarespace variant's stock to the count KaratOS has", kind: "update", approval: "each", dailyCap: 20 },
  { integration: "squarespace", name: "fulfill_order", description: "Mark a Squarespace order fulfilled once it has shipped", kind: "update", approval: "each", dailyCap: 20 },
];

const DAY_MS = 86_400_000;
/** Each later pass reads orders modified from this long before the last one ended. */
export const SQUARESPACE_OVERLAP_MS = DAY_MS;
export const SQUARESPACE_STEPS = ["products", "inventory", "orders"] as const satisfies readonly SquarespaceList[];

/** A pass under way: orders modified after `from` and up to `to`, the step it is on and that step's next page. */
export interface SquarespacePass {
  from: string;
  to: string;
  step: SquarespaceList;
  cursor: string | null;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync's orders start. */
export interface SquarespaceCursor {
  pass: SquarespacePass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface SquarespaceOptions extends SquarespaceClientOptions {
  /** The instance's CUSTOMER_REF_KEY, for customer references. */
  customerKey: string;
  /** Orders modified longer ago than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: SquarespaceClient;
}

/** A time as toISOString writes it, which reads back as itself. */
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseSquarespaceCursor(raw: string | null): SquarespaceCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Unreadable JSON leaves c undefined, which the checks below turn down.
  }
  // Anything but an object reads as a checkpoint without the fields asked for.
  const r = (c ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const pass = isTime(p.from) && isTime(p.to) && p.from <= p.to && SQUARESPACE_STEPS.includes(p.step as SquarespaceList) && (p.cursor === null || typeof p.cursor === "string") ? { from: p.from, to: p.to, step: p.step as SquarespaceList, cursor: p.cursor as string | null } : null;
  if (typeof r.done === "boolean" && isTime(r.nextFrom) && (r.pass === null || pass)) return { pass, done: r.done, nextFrom: r.nextFrom };
  throw new Error("Squarespace checkpoint is not in the expected shape");
}

const EVENTS: Record<SquarespaceList, (raw: unknown, ctx: SquarespaceContext) => SquarespaceEvent> = { products: squarespaceProductEvent, inventory: squarespaceStockEvent, orders: squarespaceOrderEvent };

export function squarespaceConnector(options: SquarespaceOptions): Connector {
  const customerKey = checkCustomerRefKey(options.customerKey);
  const now = options.now ?? (() => new Date());
  const client = options.client ?? squarespaceClient(options);
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass from where it stands to its end. `done` is what the checkpoint says of the import while the pass runs, and `doneAtEnd` once it ends. */
  async function* walk(start: SquarespacePass, done: boolean, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const ctx: SquarespaceContext = { receivedAt: now().toISOString(), customerKey };
    const nextFrom = new Date(Date.parse(start.to) - SQUARESPACE_OVERLAP_MS).toISOString();
    let pass = start;
    for (let last = false; !last; ) {
      const result = await client.list(pass.step, { cursor: pass.cursor, from: pass.from, to: pass.to });
      const events = result.records.map((r) => EVENTS[pass.step](r, ctx));
      const following = SQUARESPACE_STEPS[SQUARESPACE_STEPS.indexOf(pass.step) + 1];
      last = result.next === null && following === undefined;
      if (result.next !== null) pass = { ...pass, cursor: result.next };
      else if (following) pass = { ...pass, step: following, cursor: null };
      const cursor: SquarespaceCursor = last ? { pass: null, done: doneAtEnd, nextFrom } : { pass, done, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSquarespaceCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, false, true);
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ from: from.toISOString(), to: at.toISOString(), step: "products", cursor: null }, false, true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSquarespaceCursor(context.cursor);
    if (saved?.pass) return yield* walk(saved.pass, saved.done, saved.done);
    const at = now();
    const done = saved?.done ?? false;
    yield* walk({ from: saved?.nextFrom ?? new Date(at.getTime() - SQUARESPACE_OVERLAP_MS).toISOString(), to: at.toISOString(), step: "products", cursor: null }, done, done);
  }

  return { source: "squarespace", historicalImport, incrementalSync, writes: SQUARESPACE_WRITES };
}
