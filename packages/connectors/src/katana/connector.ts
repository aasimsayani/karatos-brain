import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { katanaClient, type KatanaClient, type KatanaClientOptions } from "./client.js";
import { katanaCountEvent, katanaOrderEvent } from "./normalize.js";

/**
 * Katana: a small maker's manufacturing orders, with their costs and
 * whether their materials are in stock, and stock by item and location, so
 * production sees job costs and shortages before they hold up an order.
 *
 * A pass reads manufacturing orders a page at a time, then all of the
 * stock:
 *
 * - The historical import reads the orders created in the last five years.
 * - Each later sync reads the orders changed (deleted ones included) since
 *   an hour before the last pass started, then the stock again. Katana's
 *   stock list has no change filter, so it is read whole each time; a
 *   count read again the same day unchanged is a duplicate.
 *
 * Each page is one batch and one checkpoint, which keeps the pass's stage,
 * page and start time, so a resumed pass goes on from there. Katana can
 * send webhooks, but the connector polls so it needs no public route.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const KATANA_WRITES: WriteAction[] = [
  { integration: "katana", name: "create_manufacturing_order", description: "Create a Katana manufacturing order for a sales order or a reorder", kind: "append", approval: "each", dailyCap: 20 },
];

/** Each later pass reads orders changed since this long before the last one started. */
export const KATANA_OVERLAP_MS = 3_600_000;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Where a pass stands: reading orders created or changed since `since`, or stock, at `page`. */
export interface KatanaPass {
  stage: "orders" | "stock";
  page: number;
  since: string;
}

/** Serialized as the runSync checkpoint. `pass` is null between passes; `nextFrom` is where the next later sync's orders start. */
export interface KatanaCursor {
  pass: KatanaPass | null;
  /** The historical import finished. */
  done: boolean;
  nextFrom: string;
}

export interface KatanaOptions extends Partial<Pick<KatanaClientOptions, "fetch" | "sleep" | "retries">> {
  apiKey: string;
  /** Orders created more than this many years ago are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: KatanaClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && UTC_TIME.test(v) && new Date(Date.parse(v)).toISOString() === v;

export function parseKatanaCursor(raw: string | null): KatanaCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    c = null;
  }
  const r = typeof c === "object" && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  if (r && typeof r.done === "boolean" && isTime(r.nextFrom)) {
    if (r.pass === null) return { pass: null, done: r.done, nextFrom: r.nextFrom };
    const p = r.pass as Record<string, unknown> | undefined;
    if ((p?.stage === "orders" || p?.stage === "stock") && Number.isSafeInteger(p.page) && (p.page as number) >= 1 && isTime(p.since)) {
      return { pass: { stage: p.stage, page: p.page as number, since: p.since }, done: r.done, nextFrom: r.nextFrom };
    }
  }
  throw new Error("Katana checkpoint is not in the expected shape");
}

export function katanaConnector(options: KatanaOptions): Connector {
  const client = options.client ?? katanaClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads a pass to its end. `created` says the orders are those created since `since` (the import) rather than changed since. */
  async function* walk(start: KatanaPass, created: boolean, done: boolean, doneAtEnd: boolean, nextFrom: string, receivedAt: string): AsyncIterable<SourceBatch> {
    let pass = start;
    for (;;) {
      const orders = pass.stage === "orders";
      const page = orders
        ? await client.manufacturingOrders({ field: created ? "created_at_min" : "updated_at_min", since: pass.since }, pass.page)
        : await client.inventory(pass.page);
      const events = page.rows.map((row) => (orders ? katanaOrderEvent(row, { receivedAt }) : katanaCountEvent(row, { receivedAt })));
      const next: KatanaPass | null = page.more ? { ...pass, page: pass.page + 1 } : orders ? { ...pass, stage: "stock", page: 1 } : null;
      const cursor: KatanaCursor = next ? { pass: next, done, nextFrom } : { pass: null, done: doneAtEnd, nextFrom };
      yield { events, cursor: JSON.stringify(cursor) };
      if (!next) return;
      pass = next;
    }
  }

  const before = (t: Date) => new Date(t.getTime() - KATANA_OVERLAP_MS).toISOString();

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseKatanaCursor(context.cursor);
    if (saved?.done) return;
    if (saved?.pass) return yield* walk(saved.pass, true, false, true, saved.nextFrom, now().toISOString());
    const at = now();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    yield* walk({ stage: "orders", page: 1, since: from.toISOString() }, true, false, true, before(at), at.toISOString());
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseKatanaCursor(context.cursor);
    const at = now();
    if (saved?.pass) return yield* walk(saved.pass, false, saved.done, saved.done, saved.nextFrom, at.toISOString());
    const done = saved?.done ?? false;
    yield* walk({ stage: "orders", page: 1, since: saved?.nextFrom ?? before(at) }, false, done, done, before(at), at.toISOString());
  }

  return { source: "katana", historicalImport, incrementalSync, writes: KATANA_WRITES };
}

