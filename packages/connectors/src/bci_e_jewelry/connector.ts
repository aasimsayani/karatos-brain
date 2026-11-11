import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { EJEWELRY_LISTS, ejewelryClient, type EJewelryClient, type EJewelryClientOptions, type EJewelryList } from "./client.js";
import { eJewelryBillEvent, eJewelryInstant, eJewelryInvoiceEvent, eJewelryItemEvent, eJewelryVendorEvent, type EJewelryContext, type EJewelryRead } from "./normalize.js";

/**
 * e-Jewelry for Business Central: a jeweler's items, vendors, sales
 * invoices and purchase invoices, read from the Business Central company
 * e-Jewelry runs in, into one picture with retail and memo.
 *
 * Business Central pages a list itself and hands back a next link, so:
 *
 * - The historical import reads every item and vendor, then the sales and
 *   purchase invoices changed in the last five years.
 * - Each later sync reads what changed since the newest change the last
 *   one saw, less ten minutes. The first later sync looks back three days.
 *   A row read again unchanged is a duplicate.
 *
 * Each page is one batch, and the checkpoint keeps the list, its start,
 * the next link and the newest change seen. Memos, jobs and diamond records
 * are e-Jewelry's own pages, which it doesn't publish an API for, so they
 * aren't read yet.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client has no way to send them. */
export const EJEWELRY_WRITES: WriteAction[] = [
  { integration: "bci_e_jewelry", name: "create_sales_quote", description: "Create a draft sales quote in e-Jewelry", kind: "draft", approval: "each", dailyCap: 20 },
  { integration: "bci_e_jewelry", name: "update_item", description: "Update an item's attributes in e-Jewelry", kind: "update", approval: "each", dailyCap: 20 },
];

const MINUTE_MS = 60_000;
/** Each later sync reads from this long before the newest change the last one saw. */
export const EJEWELRY_OVERLAP_MS = 10 * MINUTE_MS;
/** A first later sync with no checkpoint reads changes this far back. */
export const EJEWELRY_FIRST_LOOKBACK_MS = 3 * 1440 * MINUTE_MS;
const INVOICES: ReadonlySet<EJewelryList> = new Set(["salesInvoices", "purchaseInvoices"]);

/** Where a list stands: its start (null to read it whole), the next link, and the newest change seen. */
export interface EJewelryPass {
  list: EJewelryList;
  since: string | null;
  next: string | null;
  top: string | null;
}

/** Serialized as the runSync checkpoint. */
export interface EJewelryCursor {
  /** The historical import finished. */
  done: boolean;
  /** The newest change a finished pass of each list saw. */
  marks: Record<EJewelryList, string | null>;
  /** The list being read, or null between syncs. */
  pass: EJewelryPass | null;
}

export interface EJewelryOptions extends Pick<EJewelryClientOptions, "tenantId" | "environment" | "companyId" | "clientId" | "clientSecret">, Partial<Pick<EJewelryClientOptions, "fetch" | "sleep" | "retries">> {
  /** Invoices last changed longer ago than this many years are skipped. Defaults to 5. */
  historyYears?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: EJewelryClient;
}

const isTime = (v: unknown): v is string => typeof v === "string" && eJewelryInstant(v) === v;
const mark = (v: unknown) => v === null || isTime(v);
const MESSAGE = "e-Jewelry checkpoint is not in the expected shape";

export function parseEJewelryCursor(raw: string | null, client: EJewelryClient): EJewelryCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  const r = (c ?? {}) as Record<string, unknown>;
  const m = (r.marks ?? {}) as Record<string, unknown>;
  const p = (r.pass ?? {}) as Record<string, unknown>;
  const list = p.list as EJewelryList;
  const pass = r.pass === null || (EJEWELRY_LISTS.includes(list) && mark(p.since) && (p.next === null || (typeof p.next === "string" && p.next.startsWith(`${client.listUrl(list)}?`))) && mark(p.top));
  if (typeof r.done !== "boolean" || !EJEWELRY_LISTS.every((l) => mark(m[l])) || !pass) throw new Error(MESSAGE);
  return {
    done: r.done,
    marks: Object.fromEntries(EJEWELRY_LISTS.map((l) => [l, m[l]])) as Record<EJewelryList, string | null>,
    pass: EJEWELRY_LISTS.includes(list) ? { list, since: p.since as string | null, next: p.next as string | null, top: p.top as string | null } : null,
  };
}

const EVENTS = new Map<EJewelryList, (raw: unknown, ctx: EJewelryContext) => EJewelryRead>([
  ["items", eJewelryItemEvent],
  ["vendors", eJewelryVendorEvent],
  ["salesInvoices", eJewelryInvoiceEvent],
  ["purchaseInvoices", eJewelryBillEvent],
]);

export function eJewelryConnector(options: EJewelryOptions): Connector {
  const client = options.client ?? ejewelryClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");

  /** Reads each list to its end, from where `state` stands. `sinceFor` is where a list starts that has no pass yet. */
  async function* read(state: EJewelryCursor, sinceFor: (list: EJewelryList) => string | null, doneAtEnd: boolean): AsyncIterable<SourceBatch> {
    const { marks } = state;
    let pass = state.pass ?? { list: EJEWELRY_LISTS[0], since: sinceFor(EJEWELRY_LISTS[0]), next: null, top: null };
    for (;;) {
      const page = await client.page(pass.list, pass.since, pass.next);
      const ctx = { receivedAt: now().toISOString() };
      const toEvent = EVENTS.get(pass.list)!;
      const events = page.rows.map((row) => toEvent(row, ctx).event);
      for (const row of page.rows) {
        const changed = eJewelryInstant((row as { lastModifiedDateTime?: unknown } | null)?.lastModifiedDateTime);
        if (changed !== undefined && changed > (pass.top ?? "")) pass = { ...pass, top: changed };
      }
      let last = false;
      if (page.next !== null) pass = { ...pass, next: page.next };
      else {
        marks[pass.list] = pass.top ?? marks[pass.list];
        const next = EJEWELRY_LISTS[EJEWELRY_LISTS.indexOf(pass.list) + 1];
        if (next) pass = { list: next, since: sinceFor(next), next: null, top: null };
        else last = true;
      }
      const cursor: EJewelryCursor = { done: last ? doneAtEnd : state.done, marks, pass: last ? null : pass };
      yield { events, cursor: JSON.stringify(cursor) };
      if (last) return;
    }
  }

  const fresh = (): EJewelryCursor => ({ done: false, marks: { items: null, vendors: null, salesInvoices: null, purchaseInvoices: null }, pass: null });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseEJewelryCursor(context.cursor, client);
    if (saved?.done) return;
    const floor = now();
    floor.setUTCFullYear(floor.getUTCFullYear() - historyYears);
    yield* read(saved ?? fresh(), (list) => (INVOICES.has(list) ? floor.toISOString() : null), true);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const state = parseEJewelryCursor(context.cursor, client) ?? fresh();
    const sinceFor = (list: EJewelryList) => {
      const seen = state.marks[list];
      return new Date(seen ? Date.parse(seen) - EJEWELRY_OVERLAP_MS : now().getTime() - EJEWELRY_FIRST_LOOKBACK_MS).toISOString();
    };
    yield* read(state, sinceFor, state.done);
  }

  return { source: "bci_e_jewelry", historicalImport, incrementalSync, writes: EJEWELRY_WRITES };
}
