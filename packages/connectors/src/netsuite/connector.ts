import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { NETSUITE_MAX_ROWS, NETSUITE_PAGE_SIZE, NETSUITE_TIME, netSuiteClient, type NetSuiteClient, type NetSuiteClientOptions, type NetSuiteList } from "./client.js";
import { netSuiteItemEvent, netSuiteStockEvent, netSuiteTransactionEvent, netSuiteVendorEvent, type NetSuiteContext, type NetSuiteRead } from "./normalize.js";

/**
 * NetSuite: a wholesaler's or manufacturer's items, vendors, sales and
 * purchase orders, invoices, journal entries and stock by location, read
 * into one picture with retail and memo.
 *
 * SuiteQL reads each list oldest change first, 1,000 rows a page by offset,
 * and a query reads 100,000 rows at most. So:
 *
 * - The historical import reads every item and vendor, the transactions of
 *   the last six years, then stock by location.
 * - Each later sync reads what changed since the newest change the last
 *   one saw, less ten minutes, and stock by location again. The first
 *   later sync looks back three days. A row read again unchanged is a
 *   duplicate.
 * - A pass that reaches 100,000 rows starts again from the newest change it
 *   saw.
 *
 * NetSuite writes times in the account's time zone. The marks are kept as
 * NetSuite wrote them, so they compare with its own times; a start worked
 * out from this clock reaches back a day further, to cover any time zone.
 * Each page is one batch, and the checkpoint keeps the list, its start, the
 * next offset and the newest change seen.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const NETSUITE_WRITES: WriteAction[] = [
  { integration: "netsuite", name: "create_sales_order", description: "Create a sales order in NetSuite", kind: "append", approval: "each", dailyCap: 20 },
  { integration: "netsuite", name: "create_purchase_order", description: "Create a purchase order in NetSuite", kind: "append", approval: "each", dailyCap: 10 },
];

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
/** Each later sync reads from this long before the newest change the last one saw. */
export const NETSUITE_OVERLAP_MS = 10 * MINUTE_MS;
/** A first later sync with no checkpoint reads changes this far back, a day of it for the time zone. */
export const NETSUITE_FIRST_LOOKBACK_MS = 3 * DAY_MS;
/** A start worked out from this clock reaches back this much further, for the account's time zone. */
const ZONE_MS = DAY_MS;
/** The start of a list read whole. */
const EVER = "1970-01-01 00:00:00";
const LISTS: readonly NetSuiteList[] = ["items", "vendors", "transactions", "stock"];
type Marked = Exclude<NetSuiteList, "stock">;
const MARKED: readonly Marked[] = ["items", "vendors", "transactions"];

/** Where a list stands: its start (null for stock), the next offset, and the newest change seen. */
export interface NetSuitePass {
  list: NetSuiteList;
  since: string | null;
  offset: number;
  top: string | null;
}

/** Serialized as the runSync checkpoint. */
export interface NetSuiteCursor {
  /** The historical import finished. */
  done: boolean;
  /** The newest change a finished pass of each list saw, as NetSuite wrote it. */
  marks: Record<Marked, string | null>;
  /** The list being read, or null between syncs. */
  pass: NetSuitePass | null;
}

export interface NetSuiteOptions extends Pick<NetSuiteClientOptions, "accountId" | "clientId" | "certificateId" | "privateKey">, Partial<Pick<NetSuiteClientOptions, "fetch" | "sleep" | "retries">> {
  /** Transactions older than this many years are skipped. Defaults to 6. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: NetSuiteClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && NETSUITE_TIME.test(v);
const mark = (v: unknown) => v === null || isTime(v);
/** A moment as NetSuite writes it, read as if NetSuite's zone were UTC. */
const netSuiteTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const instant = (t: string) => Date.parse(`${t.replace(" ", "T")}Z`);

export function parseNetSuiteCursor(raw: string | null): NetSuiteCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const m = (r.marks ?? null) as Record<string, unknown> | null;
  const marks = m !== null && MARKED.every((list) => mark(m[list]));
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const list = p.list as NetSuiteList;
  const pass =
    r.pass === null ||
    (LISTS.includes(list) && (list === "stock" ? p.since === null : isTime(p.since)) && Number.isSafeInteger(p.offset) && (p.offset as number) >= 0 && (p.offset as number) < NETSUITE_MAX_ROWS && (p.offset as number) % NETSUITE_PAGE_SIZE === 0 && mark(p.top));
  if (typeof r.done === "boolean" && marks && pass) {
    return {
      done: r.done,
      marks: { items: m!.items as string | null, vendors: m!.vendors as string | null, transactions: m!.transactions as string | null },
      pass: r.pass === null ? null : { list, since: p.since as string | null, offset: p.offset as number, top: p.top as string | null },
    };
  }
  throw new Error("NetSuite checkpoint is not in the expected shape");
}

const EVENTS: Record<NetSuiteList, (raw: unknown, ctx: NetSuiteContext) => NetSuiteRead> = {
  items: netSuiteItemEvent,
  vendors: netSuiteVendorEvent,
  transactions: netSuiteTransactionEvent,
  stock: netSuiteStockEvent,
};

export function netSuiteConnector(options: NetSuiteOptions): Connector {
  const client = options.client ?? netSuiteClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 6;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads each list to its end, from where `state` stands. `sinceFor` is where a list starts that has no pass yet. */
  async function* read(state: NetSuiteCursor, sinceFor: (list: NetSuiteList) => string | null, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const { marks } = state;
    let pass = state.pass ?? { list: LISTS[0]!, since: sinceFor(LISTS[0]!), offset: 0, top: null };
    for (;;) {
      const page = await client.page(pass.list, pass.since, pass.offset);
      const ctx = { receivedAt: now().toISOString() };
      const events = page.rows.map((row) => EVENTS[pass.list](row, ctx).event);
      for (const row of page.rows) {
        const changed = (row as { modified?: unknown } | null)?.modified;
        // Stock rows have no change time, so a stock pass never moves a mark.
        if (isTime(changed) && changed > (pass.top ?? "")) pass = { ...pass, top: changed };
      }
      let last = false;
      const full = page.more && page.rows.length === NETSUITE_PAGE_SIZE;
      if (full && pass.offset + NETSUITE_PAGE_SIZE < NETSUITE_MAX_ROWS) pass = { ...pass, offset: pass.offset + NETSUITE_PAGE_SIZE };
      // Only a list with a start has a top.
      else if (full && pass.top !== null && pass.top > pass.since!) pass = { ...pass, since: pass.top, offset: 0 };
      else if (full && pass.since !== null) throw new Error(`NetSuite has more than ${NETSUITE_MAX_ROWS} ${pass.list} changed in one second, more than SuiteQL can page through`);
      else {
        if (pass.list !== "stock") marks[pass.list] = pass.top ?? marks[pass.list];
        const next = LISTS[LISTS.indexOf(pass.list) + 1];
        if (next) pass = { list: next, since: sinceFor(next), offset: 0, top: null };
        else last = true;
      }
      const cursor: NetSuiteCursor = { done: last ? doneAtEnd : state.done, marks, pass: last ? null : pass };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  const fresh = (): NetSuiteCursor => ({ done: false, marks: { items: null, vendors: null, transactions: null }, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseNetSuiteCursor(context.cursor);
    if (saved?.done) return;
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    const sinceFor = (list: NetSuiteList) => (list === "stock" ? null : list === "transactions" ? netSuiteTime(floor.getTime() - ZONE_MS) : EVER);
    yield* read(saved ?? fresh(), sinceFor, true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseNetSuiteCursor(context.cursor) ?? fresh();
    const sinceFor = (list: NetSuiteList) => {
      if (list === "stock") return null;
      const seen = state.marks[list];
      return netSuiteTime(seen ? instant(seen) - NETSUITE_OVERLAP_MS : now().getTime() - NETSUITE_FIRST_LOOKBACK_MS);
    };
    yield* read(state, sinceFor, state.done);
  }

  return { source: "netsuite", historicalImport, incrementalSync, writes: NETSUITE_WRITES };
}
