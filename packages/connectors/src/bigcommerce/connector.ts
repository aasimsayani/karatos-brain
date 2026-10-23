import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { bigCommerceClient, type BigCommerceClient, type BigCommerceClientOptions } from "./client.js";
import { bigCommerceCustomerRef, checkBigCommerceCustomerKey } from "./customer.js";
import {
  BIGCOMMERCE_REFUNDED_STATUSES,
  bigCommerceCents,
  bigCommerceCount,
  bigCommerceCustomerEvent,
  bigCommerceId,
  bigCommerceInventoryEvents,
  bigCommerceOrderEvents,
  bigCommercePriceListEvent,
  bigCommercePriceRecordEvent,
  bigCommerceProductEvents,
  bigCommerceTime,
  type BigCommerceBrainEvent,
  type BigCommerceContext,
  type BigCommerceRecord,
} from "./normalize.js";

/**
 * Reads products with their variants, inventory at every location,
 * customers, orders (with their lines and refunds), B2B price lists and each
 * list's prices, in that order. The historical import reads five years of
 * changes; incremental passes read what changed since the previous pass
 * started, less five minutes so nothing saved mid-pass is missed.
 *
 * Products, customers and orders are read oldest change first and paged by
 * time: each page starts at the last change time the previous page ended on,
 * skipping the records already read at that time. A record changed while a
 * pass runs moves to the end of the list instead of shifting the rest by one,
 * so none is missed the way page numbers would miss it. Inventory, price
 * lists and price list records have no change-time sort, so they are paged by
 * number.
 *
 * Inventory has no change time at all, so each pass reads every count and
 * stores the ones that changed that day.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and no write scope is requested. */
export const BIGCOMMERCE_WRITES: WriteAction[] = [
  { integration: "bigcommerce", name: "update_inventory", description: "Set a variant's stock at a location" },
  { integration: "bigcommerce", name: "update_price_list_record", description: "Set a variant's price on a B2B price list" },
];

export const BIGCOMMERCE_STREAMS = ["products", "inventory", "customers", "orders", "price_lists", "price_list_records"] as const;
export type BigCommerceStream = (typeof BIGCOMMERCE_STREAMS)[number];
type Step = BigCommerceStream | "done";
const STEPS: Step[] = [...BIGCOMMERCE_STREAMS, "done"];

/** Page sizes. Orders are smaller, since each one is followed by reads of its lines and refunds. */
export const BIGCOMMERCE_PAGE_SIZES = { products: 250, inventory: 250, customers: 250, orders: 50, orderProducts: 250, priceLists: 250, priceListRecords: 250 } as const;
/** Each incremental pass starts this long before the previous one did. */
export const BIGCOMMERCE_OVERLAP_MS = 5 * 60_000;
/** The most record IDs a checkpoint keeps for the change time a page ended on. */
const MAX_SEEN = 1000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface BigCommerceCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** Page number within the step (for paging by time, within `from`). */
  page: number;
  /** Paging by time: the change time the next page starts at, or null for the pass's `since`. */
  from: string | null;
  /** Paging by time: IDs already read at exactly `from`. */
  seen: string[];
  /** Price list records: the list being read, or null for the first. */
  listId: string | null;
  /** The pass reads changes from this time. */
  since: string;
  /** When the pass started; inventory counts are dated at it. */
  startedAt: string;
  /** Where the next incremental pass starts. */
  nextFrom: string;
}

export interface BigCommerceConnectorOptions extends BigCommerceClientOptions {
  /** CUSTOMER_REF_KEY: keys the customer references. */
  customerKey: string;
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: BigCommerceClient;
}

/** BigCommerce's times are whole seconds; the connector writes them as 2026-01-20T00:00:00Z. */
const SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isTime = (t: unknown) => typeof t === "string" && SECONDS.test(t) && !Number.isNaN(Date.parse(t));
const isId = (v: unknown) => typeof v === "string" && /^[1-9]\d{0,11}$/.test(v);
export const toSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

export function parseBigCommerceCursor(raw: string | null): BigCommerceCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as BigCommerceCursor;
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !Number.isInteger(c.page) ||
    c.page < 1 ||
    c.page > 1_000_000 ||
    !(c.from === null || isTime(c.from)) ||
    !Array.isArray(c.seen) ||
    c.seen.length > MAX_SEEN ||
    !c.seen.every(isId) ||
    !(c.listId === null || isId(c.listId)) ||
    ![c.since, c.startedAt, c.nextFrom].every(isTime)
  ) {
    throw new Error("BigCommerce checkpoint is not in the expected shape");
  }
  return c;
}

/** v3 lists: the records and whether more pages follow. */
function v3Page(body: unknown): { rows: BigCommerceRecord[]; more: boolean } {
  const b = (body ?? {}) as { data?: unknown; meta?: { pagination?: { current_page?: unknown; total_pages?: unknown } } };
  const rows = Array.isArray(b.data) ? b.data.filter((r): r is BigCommerceRecord => r !== null && typeof r === "object") : [];
  const p = b.meta?.pagination;
  const current = typeof p?.current_page === "number" ? p.current_page : 1;
  const total = typeof p?.total_pages === "number" ? p.total_pages : 1;
  return { rows, more: current < total };
}

/** v2 lists: a bare array, or nothing (204). */
const v2Rows = (body: unknown): BigCommerceRecord[] => (Array.isArray(body) ? body.filter((r): r is BigCommerceRecord => r !== null && typeof r === "object") : []);

/** A change time in the connector's whole-second form, or undefined. */
function changedAt(record: BigCommerceRecord): string | undefined {
  const t = bigCommerceTime(record.date_modified);
  return t ? toSeconds(Date.parse(t)) : undefined;
}

export function bigCommerceConnector(options: BigCommerceConnectorOptions): Connector {
  const customerKey = checkBigCommerceCustomerKey(options.customerKey);
  const client = options.client ?? bigCommerceClient(options);
  const storeHash = options.storeHash.trim();
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const customerRef = (id: unknown) => bigCommerceCustomerRef(customerKey, storeHash, id);

  function start(pass: BigCommerceCursor["pass"], since: string): BigCommerceCursor {
    const at = now().getTime();
    return { pass, step: STEPS[0]!, page: 1, from: null, seen: [], listId: null, since, startedAt: toSeconds(at), nextFrom: toSeconds(at - BIGCOMMERCE_OVERLAP_MS) };
  }

  function startHistorical(): BigCommerceCursor {
    const from = new Date(now());
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    return start("historical", toSeconds(from.getTime()));
  }

  function startIncremental(previous: BigCommerceCursor | null): BigCommerceCursor {
    return start("incremental", previous?.nextFrom ?? toSeconds(now().getTime() - lookbackHours * 3_600_000));
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseBigCommerceCursor(context.cursor);
    let cursor: BigCommerceCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }
    let priceListIds: string[] | null = null;

    type Read = { events: BigCommerceBrainEvent[]; next: Partial<BigCommerceCursor> | null };
    const ctx = (): BigCommerceContext => ({ receivedAt: now().toISOString(), customerRef });

    /**
     * After a page read by change time: where the next page starts, or null
     * when the stream is done. A full page moves `from` to the last change
     * time on it; a page all at one time (more records share it than fit on
     * a page) moves to the next page number instead.
     */
    function byTime(c: BigCommerceCursor, rows: BigCommerceRecord[], size: number): Partial<BigCommerceCursor> | null {
      if (rows.length < size) return null;
      const from = c.from ?? c.since;
      const times = rows.map(changedAt).filter((t): t is string => t !== undefined);
      const last = times.reduce((a, b) => (b > a ? b : a), from);
      if (last > from) {
        const seen = rows.filter((r) => changedAt(r) === last).flatMap((r) => bigCommerceId(r.id) ?? []);
        if (seen.length <= MAX_SEEN) return { from: last, page: 1, seen };
      }
      return { page: c.page + 1 };
    }

    /** Drops the records a previous page already read at the change time this page starts at. */
    const unseen = (c: BigCommerceCursor, rows: BigCommerceRecord[]) =>
      c.page === 1 && c.seen.length ? rows.filter((r) => !(changedAt(r) === (c.from ?? c.since) && c.seen.includes(bigCommerceId(r.id) ?? ""))) : rows;

    async function allPriceListIds(): Promise<string[]> {
      if (priceListIds) return priceListIds;
      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const { rows, more } = v3Page(await client.read("priceLists", { query: { page, limit: BIGCOMMERCE_PAGE_SIZES.priceLists } }));
        ids.push(...rows.flatMap((r) => bigCommerceId(r.id) ?? []));
        if (!more || !rows.length) break;
      }
      priceListIds = [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
      return priceListIds;
    }

    async function orderLines(id: string): Promise<BigCommerceRecord[]> {
      const lines: BigCommerceRecord[] = [];
      for (let page = 1; ; page++) {
        const rows = v2Rows(await client.read("orderProducts", { path: { order_id: id }, query: { page, limit: BIGCOMMERCE_PAGE_SIZES.orderProducts } }));
        lines.push(...rows);
        if (rows.length < BIGCOMMERCE_PAGE_SIZES.orderProducts) return lines;
      }
    }

    async function readStep(c: BigCommerceCursor): Promise<Read> {
      const from = c.from ?? c.since;
      switch (c.step as BigCommerceStream) {
        case "products": {
          const size = BIGCOMMERCE_PAGE_SIZES.products;
          const body = await client.read("products", { query: { "date_modified:min": from, sort: "date_modified", direction: "asc", include: "variants", page: c.page, limit: size } });
          const { rows } = v3Page(body);
          return { events: unseen(c, rows).flatMap((p) => bigCommerceProductEvents(p, ctx())), next: byTime(c, rows, size) };
        }
        case "inventory": {
          const { rows, more } = v3Page(await client.read("inventoryItems", { query: { page: c.page, limit: BIGCOMMERCE_PAGE_SIZES.inventory } }));
          return { events: rows.flatMap((item) => bigCommerceInventoryEvents(item, new Date(c.startedAt).toISOString(), ctx())), next: more && rows.length ? { page: c.page + 1 } : null };
        }
        case "customers": {
          const size = BIGCOMMERCE_PAGE_SIZES.customers;
          const { rows } = v3Page(await client.read("customers", { query: { "date_modified:min": from, sort: "date_modified:asc", page: c.page, limit: size } }));
          return { events: unseen(c, rows).flatMap((r) => bigCommerceCustomerEvent(r, ctx()) ?? []), next: byTime(c, rows, size) };
        }
        case "orders": {
          const size = BIGCOMMERCE_PAGE_SIZES.orders;
          const rows = v2Rows(await client.read("orders", { query: { min_date_modified: from, sort: "date_modified:asc", page: c.page, limit: size } }));
          const events: BigCommerceBrainEvent[] = [];
          for (const order of unseen(c, rows)) {
            const id = bigCommerceId(order.id);
            if (!id) continue;
            const lines = await orderLines(id);
            const statusId = bigCommerceCount(order.status_id);
            const refunded = (bigCommerceCents(order.refunded_amount) ?? 0) > 0 || (statusId !== null && BIGCOMMERCE_REFUNDED_STATUSES.has(statusId));
            const refunds = refunded ? v3Page(await client.read("orderRefunds", { path: { order_id: id } })).rows : [];
            events.push(...bigCommerceOrderEvents(order, lines, refunds, ctx()));
          }
          return { events, next: byTime(c, rows, size) };
        }
        case "price_lists": {
          const { rows, more } = v3Page(await client.read("priceLists", { query: { page: c.page, limit: BIGCOMMERCE_PAGE_SIZES.priceLists } }));
          // Every list is read each pass: there are few, and a list's events are keyed by its change time.
          return { events: rows.flatMap((r) => bigCommercePriceListEvent(r, ctx()) ?? []), next: more && rows.length ? { page: c.page + 1 } : null };
        }
        case "price_list_records": {
          const ids = await allPriceListIds();
          // The list being read, or the next one by ID if it has gone since.
          const listId = c.listId === null ? ids[0] : ids.find((id) => Number(id) >= Number(c.listId));
          if (!listId) return { events: [], next: null };
          const { rows, more } = v3Page(
            await client.read("priceListRecords", {
              path: { price_list_id: listId },
              query: { "date_modified:min": c.pass === "incremental" ? c.since : undefined, include: "sku", page: listId === c.listId ? c.page : 1, limit: BIGCOMMERCE_PAGE_SIZES.priceListRecords },
            }),
          );
          const page = listId === c.listId ? c.page : 1;
          const events = rows.flatMap((r) => bigCommercePriceRecordEvent({ price_list_id: Number(listId), ...r }, ctx()) ?? []);
          if (more && rows.length) return { events, next: { listId, page: page + 1 } };
          const after = ids.find((id) => Number(id) > Number(listId));
          return { events, next: after ? { listId: after, page: 1 } : null };
        }
      }
    }

    while (cursor.step !== "done") {
      const { events, next } = await readStep(cursor);
      cursor = next
        ? { ...cursor, ...next }
        : { ...cursor, step: STEPS[STEPS.indexOf(cursor.step) + 1]!, page: 1, from: null, seen: [], listId: null };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "bigcommerce",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: BIGCOMMERCE_WRITES,
  };
}
