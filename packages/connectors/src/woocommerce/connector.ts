import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { WOOCOMMERCE_PAGE_SIZE, wooCommerceClient, type WooCommerceClient, type WooCommerceClientOptions, type WooCommercePage } from "./client.js";
import { checkWooCommerceCustomerKey, wooCommerceCustomerRef } from "./customer.js";
import { wooCustomerEvent, wooId, wooOrderEvents, wooProductEvents, wooRefundEvents, type WooCommerceBrainEvent, type WooCommerceContext, type WooRecord } from "./normalize.js";
import { wooCommerceWebhookEvents, type WooCommerceWebhookDelivery } from "./webhooks.js";

/**
 * Reads products with their variations and stock, orders, refunds and
 * customers, in that order. The historical import reads the whole catalog,
 * every customer, and five years of orders and refunds. Incremental passes
 * read what changed since the newest change the last pass saw, less five
 * minutes so nothing saved mid-pass is missed.
 *
 * WooCommerce pages by number (`page`, `per_page` up to 100, with the page
 * count in `X-WP-TotalPages`). Paging by number through a list that changes
 * underneath can skip a record, so orders, products and refunds are read
 * oldest change first and, after each page, the next request starts from
 * just before the newest change on it (page 1 again). Only a run of more
 * than a page of records changed in the same second is paged by number.
 *
 * Customers can't be filtered by change: the import reads them all, and an
 * incremental pass reads the newest registrations until it reaches ones it
 * has seen. A customer's profile holds only its keyed reference, so a
 * later edit changes nothing the connector keeps.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the key holds Read permission only. */
export const WOOCOMMERCE_WRITES: WriteAction[] = [
  { integration: "woocommerce", name: "update_stock", description: "Set a product's or variation's stock quantity" },
  { integration: "woocommerce", name: "update_product", description: "Update a product's details or price" },
];

export const WOOCOMMERCE_STREAMS = ["products", "orders", "refunds", "customers"] as const;
export type WooCommerceStream = (typeof WOOCOMMERCE_STREAMS)[number];
type Step = WooCommerceStream | "done";
const STEPS: Step[] = [...WOOCOMMERCE_STREAMS, "done"];

/** Each incremental pass starts this long before the newest change the last one saw. */
export const WOOCOMMERCE_OVERLAP_MS = 5 * 60_000;
/**
 * The refunds list filters on the store's local time and documents no way
 * to ask for GMT, so refund windows reach this much further back; the
 * widest time zone is 14 hours from GMT. Refunds are keyed by ID, so the
 * overlap stores nothing twice.
 */
export const WOOCOMMERCE_LOCAL_TIME_SLACK_MS = 24 * 3_600_000;
/** Where the catalog starts: everything. */
const CATALOG_START = "2000-01-01T00:00:00";

/** Where a sync stands. Serialized as the runSync checkpoint. Times are WooCommerce's YYYY-MM-DDTHH:MM:SS. */
export interface WooCommerceCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The page within the current window, from 1. */
  page: number;
  /** Orders, products and refunds: the current window starts after this time. Null for customers. */
  after: string | null;
  /** Where each stream's pass started: GMT, except refunds, which are the store's local time. */
  since: Record<WooCommerceStream, string>;
  /** The newest change seen per stream (refunds: creation, local time; customers: registration, GMT). */
  latest: Partial<Record<WooCommerceStream, string>>;
}

export interface WooCommerceConnectorOptions extends WooCommerceClientOptions {
  /** CUSTOMER_REF_KEY: keys the customer references. */
  customerKey: string;
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: WooCommerceClient;
}

const WOO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const isWooTime = (t: unknown): t is string => typeof t === "string" && WOO_TIME.test(t) && !Number.isNaN(Date.parse(`${t}Z`));
const MAX_PAGE = 100_000;

/** ISO or Date → WooCommerce's zone-less form. */
const wooFormat = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const shift = (t: string, ms: number) => wooFormat(Date.parse(`${t}Z`) + ms);
/** The record's time in WooCommerce's zone-less form, or undefined. */
const fieldTime = (record: WooRecord, field: string): string | undefined => {
  const v = record[field];
  return typeof v === "string" && v.length >= 19 && v.length <= 40 && isWooTime(v.slice(0, 19)) ? v.slice(0, 19) : undefined;
};

export function parseWooCommerceCursor(raw: string | null): WooCommerceCursor | null {
  if (raw === null) return null;
  if (raw.length > 4096) throw new Error("WooCommerce checkpoint is not in the expected shape");
  const c = JSON.parse(raw) as WooCommerceCursor;
  const streamTimes = (value: unknown, all: boolean) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([k, v]) => (WOOCOMMERCE_STREAMS as readonly string[]).includes(k) && isWooTime(v)) &&
    (!all || WOOCOMMERCE_STREAMS.every((s) => Object.hasOwn(value, s)));
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !Number.isInteger(c.page) ||
    c.page < 1 ||
    c.page > MAX_PAGE ||
    !(c.after === null || isWooTime(c.after)) ||
    !streamTimes(c.since, true) ||
    !streamTimes(c.latest, false)
  ) {
    throw new Error("WooCommerce checkpoint is not in the expected shape");
  }
  return c;
}

/** Whether a page has another after it: X-WP-TotalPages when sent, a full page otherwise. */
const hasMore = (page: WooCommercePage, number: number) => (page.totalPages !== null ? number < page.totalPages : page.items.length >= WOOCOMMERCE_PAGE_SIZE);

export function wooCommerceConnector(options: WooCommerceConnectorOptions): Connector {
  const customerKey = checkWooCommerceCustomerKey(options.customerKey);
  const client = options.client ?? wooCommerceClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const ctx = (receivedAt: string): WooCommerceContext => ({ receivedAt, customerRef: (id) => wooCommerceCustomerRef(customerKey, client.storeHost, id) });

  function startHistorical(): WooCommerceCursor {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const from = wooFormat(start.getTime());
    return {
      pass: "historical",
      step: STEPS[0]!,
      page: 1,
      after: CATALOG_START,
      since: { products: CATALOG_START, orders: from, refunds: shift(from, -WOOCOMMERCE_LOCAL_TIME_SLACK_MS), customers: from },
      latest: {},
    };
  }

  function startIncremental(previous: WooCommerceCursor | null): WooCommerceCursor {
    const fallback = wooFormat(now().getTime() - lookbackHours * 3_600_000);
    const since = Object.fromEntries(
      WOOCOMMERCE_STREAMS.map((s) => {
        const seen = previous?.latest[s];
        if (seen) return [s, shift(seen, -WOOCOMMERCE_OVERLAP_MS)];
        // Nothing seen yet: the last pass's start, or the lookback (wider for refunds' local times).
        return [s, previous?.since[s] ?? (s === "refunds" ? shift(fallback, -WOOCOMMERCE_LOCAL_TIME_SLACK_MS) : fallback)];
      }),
    ) as Record<WooCommerceStream, string>;
    return { pass: "incremental", step: STEPS[0]!, page: 1, after: since[STEPS[0] as WooCommerceStream], since, latest: { ...previous?.latest } };
  }

  /** Reads every variation of a variable product, all pages. */
  async function variationsOf(productId: number): Promise<WooRecord[]> {
    const all: WooRecord[] = [];
    for (let page = 1; page <= MAX_PAGE; page++) {
      const result = await client.read("variations", { per_page: WOOCOMMERCE_PAGE_SIZE, page, orderby: "id", order: "asc" }, productId);
      all.push(...result.items);
      if (!hasMore(result, page)) break;
    }
    return all;
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWooCommerceCursor(context.cursor);
    let cursor: WooCommerceCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const step = cursor.step;
      const at = now().toISOString();
      let events: WooCommerceBrainEvent[];
      let page: WooCommercePage;
      let field: string;
      if (step === "customers") {
        const incremental = cursor.pass === "incremental";
        page = await client.read("customers", {
          role: "all",
          per_page: WOOCOMMERCE_PAGE_SIZE,
          page: cursor.page,
          // The import reads by ID, which new registrations never shift; a pass reads the newest first and stops at ones it has seen.
          orderby: incremental ? "registered_date" : "id",
          order: incremental ? "desc" : "asc",
        });
        events = page.items.flatMap((r) => wooCustomerEvent(r, ctx(at)) ?? []);
        const latest = { ...cursor.latest };
        for (const r of page.items) {
          const t = fieldTime(r, "date_created_gmt");
          if (t && (!latest.customers || t > latest.customers)) latest.customers = t;
        }
        const reachedSeen = incremental && page.items.some((r) => (fieldTime(r, "date_created_gmt") ?? "") <= cursor.since.customers);
        cursor = hasMore(page, cursor.page) && !reachedSeen ? { ...cursor, page: cursor.page + 1, latest } : { ...cursor, step: "done", page: 1, after: null, latest };
        yield { events, cursor: JSON.stringify(cursor) };
        continue;
      }

      const after = cursor.after ?? cursor.since[step];
      if (step === "products") {
        field = "date_modified_gmt";
        page = await client.read("products", { modified_after: after, dates_are_gmt: true, orderby: "modified", order: "asc", status: "any", per_page: WOOCOMMERCE_PAGE_SIZE, page: cursor.page });
        events = [];
        for (const product of page.items) {
          const id = wooId(product.id);
          const variations = id && product.type === "variable" ? await variationsOf(id) : null;
          events.push(...wooProductEvents(product, variations, ctx(at)));
        }
      } else if (step === "orders") {
        field = "date_modified_gmt";
        page = await client.read("orders", { modified_after: after, dates_are_gmt: true, orderby: "modified", order: "asc", status: "any", per_page: WOOCOMMERCE_PAGE_SIZE, page: cursor.page });
        events = page.items.flatMap((o) => wooOrderEvents(o, ctx(at)));
      } else {
        // The refunds list filters `after` on the store's local creation time, so the window moves on local times.
        field = "date_created";
        page = await client.read("refunds", { after, orderby: "date", order: "asc", per_page: WOOCOMMERCE_PAGE_SIZE, page: cursor.page });
        events = page.items.flatMap((r) => wooRefundEvents(r, ctx(at)));
      }

      const latest = { ...cursor.latest };
      let newest: string | undefined;
      for (const r of page.items) {
        const t = fieldTime(r, field);
        if (t && (!newest || t > newest)) newest = t;
      }
      if (newest && (!latest[step] || newest > latest[step]!)) latest[step] = newest;
      if (!hasMore(page, cursor.page)) {
        const next = STEPS[STEPS.indexOf(step) + 1]!;
        cursor = { ...cursor, step: next, page: 1, after: next === "done" || next === "customers" ? null : cursor.since[next], latest };
      } else if (newest && shift(newest, -1000) > after) {
        // Start again just before the newest change on this page; anything that moved is read again, never skipped.
        cursor = { ...cursor, page: 1, after: shift(newest, -1000), latest };
      } else {
        // A page of records changed in the same second: page on by number.
        cursor = { ...cursor, page: cursor.page + 1, after, latest };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "woocommerce",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => wooCommerceWebhookEvents(body as WooCommerceWebhookDelivery, ctx(now().toISOString()), now()),
    writes: WOOCOMMERCE_WRITES,
  };
}
