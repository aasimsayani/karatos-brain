import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { squareClient, type SquareClient, type SquareClientOptions, type SquareRoute } from "./client.js";
import { checkSquareCustomerKey, squareCustomerRef } from "./customer.js";
import {
  itemVariationSkus,
  orderVariationIds,
  squareCountEvent,
  squareCustomerEvent,
  squareId,
  squareItemEvents,
  squareOrderEvents,
  squarePaymentEvent,
  squareRefundEvent,
  variationSku,
  type SquareBrainEvent,
  type SquareContext,
  type SquareRecord,
} from "./normalize.js";
import { squareWebhookEvents } from "./webhooks.js";

/**
 * Reads the catalog (items with their variations), inventory counts,
 * customers, orders, payments and refunds, in that order, across every
 * location. The historical import reads the whole catalog and every current
 * count, and five years of customers, orders, payments and refunds.
 * Incremental passes read what changed since the previous pass started, less
 * five minutes so nothing saved mid-pass is missed.
 *
 * Square pages with opaque cursors. The checkpoint keeps the stream, the
 * location being read and Square's cursor, so a crash or a rate limit
 * resumes at the next page.
 *
 * Order lines and inventory counts name a catalog variation, not its SKU.
 * The connector looks SKUs up in the catalog it has read this run, and asks
 * Square for any it hasn't seen (batch-retrieve, a read), so Square sales
 * carry the same SKUs as Shopify and the POS exports.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and no write scope is requested. */
export const SQUARE_WRITES: WriteAction[] = [
  { integration: "square", name: "adjust_inventory", description: "Adjust a variation's stock count at a location" },
  { integration: "square", name: "update_catalog_item", description: "Update a catalog item's details or price" },
];

export const SQUARE_STREAMS = ["catalog", "inventory", "customers", "orders", "payments", "refunds"] as const;
export type SquareStream = (typeof SQUARE_STREAMS)[number];
type Step = SquareStream | "done";

/** Page sizes: each endpoint's documented maximum, except orders, whose full objects are large. */
export const SQUARE_PAGE_SIZES = { catalog: 1000, inventory: 1000, customers: 100, orders: 500, payments: 100, refunds: 100 } as const;
/** Search Orders takes at most 10 locations at a time. */
export const SQUARE_ORDER_LOCATIONS_PER_SEARCH = 10;
/** Each incremental pass starts this long before the previous one did. */
export const SQUARE_OVERLAP_MS = 5 * 60_000;
const ORDER_STATES = ["OPEN", "COMPLETED", "CANCELED"];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface SquareCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** Square's page cursor within the step, or null for its first page. */
  page: string | null;
  /** Which location (payments) or group of 10 locations (orders) is being read, by position in ID order. */
  location: number;
  /** A historical pass reads records from this time; an incremental one, changes from it. */
  since: string;
  /** The pass reads up to this time. */
  until: string;
  /** Payments and refunds are filtered on creation too; this is the oldest the pass looks. */
  historyFrom: string;
  /** Where the next incremental pass starts. */
  nextFrom: string;
}

export interface SquareConnectorOptions extends SquareClientOptions {
  /** CUSTOMER_REF_KEY: keys the customer references. */
  customerKey: string;
  /** Years of history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  /** Only notifications for this merchant become events, when set. */
  merchantId?: string;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: SquareClient;
}

const STEPS: Step[] = [...SQUARE_STREAMS, "done"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** Square's cursors are opaque; printable ASCII without spaces, of bounded length. */
const PAGE = /^[\x21-\x7e]+$/;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t));

export function parseSquareCursor(raw: string | null): SquareCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as SquareCursor;
  if (
    !c ||
    typeof c !== "object" ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    !(c.page === null || (typeof c.page === "string" && c.page.length > 0 && c.page.length <= 4096 && PAGE.test(c.page))) ||
    !Number.isInteger(c.location) ||
    c.location < 0 ||
    c.location > 10_000 ||
    ![c.since, c.until, c.historyFrom, c.nextFrom].every(isTime)
  ) {
    throw new Error("Square checkpoint is not in the expected shape");
  }
  return c;
}

const records = (body: Record<string, unknown>, field: string): SquareRecord[] =>
  Array.isArray(body[field]) ? (body[field] as unknown[]).filter((r): r is SquareRecord => r !== null && typeof r === "object") : [];
const nextPage = (body: Record<string, unknown>) => (typeof body.cursor === "string" && body.cursor.length > 0 ? body.cursor : null);

export function squareConnector(options: SquareConnectorOptions): Connector {
  const customerKey = checkSquareCustomerKey(options.customerKey);
  const client = options.client ?? squareClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const customerRef = (id: unknown) => squareCustomerRef(customerKey, id);

  function historyStart(): string {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    return start.toISOString();
  }

  function startHistorical(): SquareCursor {
    const at = now().toISOString();
    const from = historyStart();
    // The first incremental pass picks up anything changed while the import ran.
    return { pass: "historical", step: STEPS[0]!, page: null, location: 0, since: from, until: at, historyFrom: from, nextFrom: at };
  }

  function startIncremental(previous: SquareCursor | null): SquareCursor {
    const at = now();
    const since = previous?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    return { pass: "incremental", step: STEPS[0]!, page: null, location: 0, since, until: at.toISOString(), historyFrom: historyStart(), nextFrom: new Date(at.getTime() - SQUARE_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseSquareCursor(context.cursor);
    let cursor: SquareCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : startIncremental(saved);
    }

    // Per run: SKUs by variation ID, and the merchant's locations in ID order.
    const skus = new Map<string, string | null>();
    let locations: string[] | null = null;
    const ctx = (receivedAt: string): SquareContext => ({ receivedAt, customerRef, sku: (id) => skus.get(id) ?? variationSku(id) });

    async function locationIds(): Promise<string[]> {
      if (locations) return locations;
      const body = await client.read("locations");
      // Inactive locations are read too: they carry history.
      locations = [...new Set(records(body, "locations").flatMap((l) => squareId(l.id) ?? []))].sort();
      return locations;
    }

    /** Looks up the SKUs of variations not seen yet this run, deleted ones included. */
    async function learnSkus(ids: string[]): Promise<void> {
      const unknown = [...new Set(ids)].filter((id) => !skus.has(id));
      for (let i = 0; i < unknown.length; i += 1000) {
        const chunk = unknown.slice(i, i + 1000);
        const body = await client.read("catalogBatch", { object_ids: chunk, include_deleted_objects: true });
        for (const object of records(body, "objects")) {
          const id = squareId(object.id);
          const sku = (object.item_variation_data as SquareRecord | undefined)?.sku;
          if (id && object.type === "ITEM_VARIATION") skus.set(id, typeof sku === "string" && sku.trim() ? sku.trim().slice(0, 100) : null);
        }
        // Variations Square no longer has keep their stand-in.
        for (const id of chunk) if (!skus.has(id)) skus.set(id, null);
      }
    }

    /** One page of the current step: its events, Square's next cursor, and whether the step has more locations to read. */
    async function readStep(c: SquareCursor): Promise<{ events: SquareBrainEvent[]; page: string | null; moreLocations: boolean }> {
      const incremental = c.pass === "incremental";
      const page = c.page ?? undefined;
      const read = (route: SquareRoute, params: Record<string, unknown>) => client.read(route, Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
      const at = now().toISOString();
      switch (c.step as SquareStream) {
        case "catalog": {
          const body = await read("catalogSearch", {
            object_types: ["ITEM"],
            include_deleted_objects: true,
            limit: SQUARE_PAGE_SIZES.catalog,
            cursor: page,
            begin_time: incremental ? c.since : undefined,
          });
          const items = records(body, "objects");
          for (const item of items) for (const [id, sku] of itemVariationSkus(item)) skus.set(id, sku);
          return { events: items.flatMap((i) => squareItemEvents(i, ctx(at))), page: nextPage(body), moreLocations: false };
        }
        case "inventory": {
          const body = await read("inventoryCounts", { states: ["IN_STOCK"], limit: SQUARE_PAGE_SIZES.inventory, cursor: page, updated_after: incremental ? c.since : undefined });
          const counts = records(body, "counts");
          await learnSkus(counts.flatMap((n) => squareId(n.catalog_object_id) ?? []));
          return { events: counts.flatMap((n) => squareCountEvent(n, ctx(at)) ?? []), page: nextPage(body), moreLocations: false };
        }
        case "customers": {
          const body = await read("customersSearch", {
            limit: SQUARE_PAGE_SIZES.customers,
            cursor: page,
            query: { filter: { updated_at: { start_at: c.since, end_at: c.until } }, sort: { field: "CREATED_AT", order: "ASC" } },
          });
          return { events: records(body, "customers").flatMap((r) => squareCustomerEvent(r, ctx(at)) ?? []), page: nextPage(body), moreLocations: false };
        }
        case "orders": {
          const ids = await locationIds();
          const group = ids.slice(c.location * SQUARE_ORDER_LOCATIONS_PER_SEARCH, (c.location + 1) * SQUARE_ORDER_LOCATIONS_PER_SEARCH);
          const moreLocations = (c.location + 1) * SQUARE_ORDER_LOCATIONS_PER_SEARCH < ids.length;
          if (!group.length) return { events: [], page: null, moreLocations: false };
          // The sort field must match the time the filter uses.
          const field = incremental ? "updated_at" : "created_at";
          const body = await read("ordersSearch", {
            location_ids: group,
            limit: SQUARE_PAGE_SIZES.orders,
            cursor: page,
            return_entries: false,
            query: {
              filter: { date_time_filter: { [field]: { start_at: c.since, end_at: c.until } }, state_filter: { states: ORDER_STATES } },
              sort: { sort_field: field.toUpperCase(), sort_order: "ASC" },
            },
          });
          const orders = records(body, "orders");
          await learnSkus(orders.flatMap(orderVariationIds));
          return { events: orders.flatMap((o) => squareOrderEvents(o, ctx(at))), page: nextPage(body), moreLocations };
        }
        case "payments": {
          const ids = await locationIds();
          const location = ids[c.location];
          if (!location) return { events: [], page: null, moreLocations: false };
          // Without a location Square lists only the main one; without begin_time, only the last year.
          const body = await read("payments", {
            location_id: location,
            begin_time: c.historyFrom,
            updated_at_begin_time: incremental ? c.since : undefined,
            sort_order: "ASC",
            limit: SQUARE_PAGE_SIZES.payments,
            cursor: page,
          });
          return { events: records(body, "payments").flatMap((p) => squarePaymentEvent(p, ctx(at)) ?? []), page: nextPage(body), moreLocations: c.location + 1 < ids.length };
        }
        case "refunds": {
          const body = await read("refunds", {
            begin_time: c.historyFrom,
            updated_at_begin_time: incremental ? c.since : undefined,
            sort_order: "ASC",
            limit: SQUARE_PAGE_SIZES.refunds,
            cursor: page,
          });
          return { events: records(body, "refunds").flatMap((r) => squareRefundEvent(r, ctx(at)) ?? []), page: nextPage(body), moreLocations: false };
        }
      }
    }

    while (cursor.step !== "done") {
      const { events, page, moreLocations } = await readStep(cursor);
      if (page) cursor = { ...cursor, page };
      else if (moreLocations) cursor = { ...cursor, page: null, location: cursor.location + 1 };
      else cursor = { ...cursor, step: STEPS[STEPS.indexOf(cursor.step) + 1]!, page: null, location: 0 };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "square",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => squareWebhookEvents(body, { receivedAt: now().toISOString(), customerRef, sku: variationSku }, options.merchantId),
    writes: SQUARE_WRITES,
  };
}
