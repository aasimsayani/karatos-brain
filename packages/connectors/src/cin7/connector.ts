import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { CIN7_MAX_PAGE, CIN7_PAGE_SIZE, cin7Client, type Cin7Client, type Cin7ClientOptions, type Cin7List } from "./client.js";
import { cin7CustomerEvent, cin7ProductEvent, cin7PurchaseEvent, cin7SaleEvent, cin7StockEvent, cin7SupplierEvent, cin7Time, type Cin7Context, type Cin7Read } from "./normalize.js";

/**
 * Cin7 Core: the brand's products, customers, suppliers, sales, purchases
 * and stock at each location, so wholesale, buying and inventory see the
 * stock Cin7 Core runs next to retail and marketplace sales.
 *
 * Cin7 Core filters products, customers and suppliers by when they were
 * modified, and sales and purchases by when they were updated, but its docs
 * don't say what order a page comes in. So a pass reads a list from a time
 * to its end, page by page, and the next sync starts from when that pass
 * began, less ten minutes: a record that changed while the pass was
 * reading, and moved to a page already read, is read again then. So:
 *
 * - The historical import reads every product, customer and supplier, and
 *   sales and purchases updated in the last five years, then the stock.
 * - Each later sync reads what changed since the last pass of each list
 *   began, less ten minutes, and the stock whole. The first later sync
 *   looks back three days. A record read again unchanged is a duplicate.
 *
 * Each page is one batch, and the checkpoint keeps the list, its start, the
 * next page and when the pass began, so a resumed sync goes on from that
 * page.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const CIN7_WRITES: WriteAction[] = [
  { integration: "cin7", name: "adjust_stock", description: "Adjust a product's stock at a location in Cin7 Core", kind: "update", approval: "each", dailyCap: 10 },
  { integration: "cin7", name: "create_purchase_order", description: "Create a draft purchase order for a supplier in Cin7 Core", kind: "append", approval: "each", dailyCap: 10 },
];

const MINUTE_MS = 60_000;
const DAY_MS = 1440 * MINUTE_MS;
/** Each later sync reads a list from this long before its last pass began. */
export const CIN7_OVERLAP_MS = 10 * MINUTE_MS;
/** A first later sync with no checkpoint reads what changed this far back. */
export const CIN7_FIRST_LOOKBACK_MS = 3 * DAY_MS;
const LISTS: readonly Cin7List[] = ["products", "customers", "suppliers", "sales", "purchases", "stock"];
type Marked = Exclude<Cin7List, "stock">;
const MARKED: readonly Marked[] = ["products", "customers", "suppliers", "sales", "purchases"];
/** Lists the historical import reads whole, not from a time. */
const WHOLE = new Set<Cin7List>(["products", "customers", "suppliers", "stock"]);
const EVENTS = new Map<Cin7List, (raw: unknown, ctx: Cin7Context) => Cin7Read>([
  ["products", cin7ProductEvent],
  ["customers", cin7CustomerEvent],
  ["suppliers", cin7SupplierEvent],
  ["sales", cin7SaleEvent],
  ["purchases", cin7PurchaseEvent],
  ["stock", cin7StockEvent],
]);

/** Where a list stands: its start (null for every record), the next page, and when the pass began. */
export interface Cin7Pass {
  list: Cin7List;
  since: string | null;
  page: number;
  began: string;
}

/** Serialized as the runSync checkpoint. */
export interface Cin7Cursor {
  /** The historical import finished. */
  done: boolean;
  /** When the last finished pass of each list began. */
  marks: Record<Marked, string | null>;
  /** The list being read, or null between syncs. */
  pass: Cin7Pass | null;
}

export interface Cin7Options extends Partial<Pick<Cin7ClientOptions, "fetch" | "sleep" | "clock" | "retries">> {
  accountId: string;
  applicationKey: string;
  /** Sales and purchases older than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: Cin7Client;
}

const isTime = (v: unknown): v is string => typeof v === "string" && cin7Time(v) === v;
const mark = (v: unknown) => v === null || isTime(v);

export function parseCin7Cursor(raw: string | null): Cin7Cursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    // Not JSON: fails the checks below.
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const m = (r.marks ?? {}) as Record<string, unknown>;
  const marks = MARKED.every((list) => mark(m[list]));
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const list = p.list as Cin7List;
  const pass = r.pass === null || (LISTS.includes(list) && (list === "stock" ? p.since === null : mark(p.since)) && Number.isSafeInteger(p.page) && (p.page as number) >= 1 && (p.page as number) <= CIN7_MAX_PAGE && isTime(p.began));
  if (typeof r.done === "boolean" && marks && pass) {
    return {
      done: r.done,
      marks: { products: m.products as string | null, customers: m.customers as string | null, suppliers: m.suppliers as string | null, sales: m.sales as string | null, purchases: m.purchases as string | null },
      pass: r.pass === null ? null : { list, since: p.since as string | null, page: p.page as number, began: p.began as string },
    };
  }
  throw new Error("Cin7 Core checkpoint is not in the expected shape");
}

export function cin7Connector(options: Cin7Options): Connector {
  const client = options.client ?? cin7Client(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads each list to its end, from where `state` stands. `sinceFor` is where a list starts that has no pass yet. */
  async function* read(state: Cin7Cursor, sinceFor: (list: Cin7List) => string | null, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const { marks } = state;
    const start = (list: Cin7List): Cin7Pass => ({ list, since: sinceFor(list), page: 1, began: now().toISOString() });
    let pass = state.pass ?? start(LISTS[0]!);
    for (;;) {
      const page = await client.page(pass.list, pass.since, pass.page);
      const ctx = { receivedAt: now().toISOString() };
      const events = page.rows.map((row) => EVENTS.get(pass.list)!(row, ctx).event);
      let last = false;
      const more = page.rows.length === CIN7_PAGE_SIZE && pass.page * CIN7_PAGE_SIZE < page.total;
      if (more && pass.page < CIN7_MAX_PAGE) pass = { ...pass, page: pass.page + 1 };
      else if (more) throw new Error(`Cin7 Core has more than ${CIN7_MAX_PAGE * CIN7_PAGE_SIZE} ${pass.list} to read in one pass`);
      else {
        if (pass.list !== "stock") marks[pass.list] = pass.began;
        const next = LISTS[LISTS.indexOf(pass.list) + 1];
        if (next) pass = start(next);
        else last = true;
      }
      const cursor: Cin7Cursor = { done: last ? doneAtEnd : state.done, marks, pass: last ? null : pass };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  const fresh = (): Cin7Cursor => ({ done: false, marks: { products: null, customers: null, suppliers: null, sales: null, purchases: null }, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseCin7Cursor(context.cursor);
    if (saved?.done) return;
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* read(saved ?? fresh(), (list) => (WHOLE.has(list) ? null : floor.toISOString()), true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseCin7Cursor(context.cursor) ?? fresh();
    const sinceFor = (list: Cin7List) => {
      if (list === "stock") return null;
      const began = state.marks[list];
      return new Date(began ? Date.parse(began) - CIN7_OVERLAP_MS : now().getTime() - CIN7_FIRST_LOOKBACK_MS).toISOString();
    };
    yield* read(state, sinceFor, state.done);
  }

  return { source: "cin7", historicalImport, incrementalSync, writes: CIN7_WRITES };
}
