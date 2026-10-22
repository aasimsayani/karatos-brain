import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { WixApiError, wixClient, type WixClient, type WixClientOptions } from "./client.js";
import { checkWixCustomerKey, wixCustomerRef } from "./customer.js";
import { wixContactEvent, wixId, wixInventoryItemEvents, wixOrderEvents, wixProductV1Events, wixProductV3Events, wixTime, type WixBrainEvent, type WixContext, type WixRecord } from "./normalize.js";
import { wixWebhookEvents, type WixWebhookDelivery } from "./webhooks.js";

/**
 * Reads the catalog, stock, eCommerce orders and contacts of one Wix site,
 * in that order. The historical import reads the whole catalog, all stock,
 * every contact and five years of orders (by when they last changed).
 * Incremental passes read what changed since the newest change the last pass
 * saw, less five minutes so nothing saved mid-pass is missed.
 *
 * Wix Stores runs one of two catalogs, which aren't compatible, so each pass
 * starts by asking which one the site has (Get Catalog Version):
 * - Catalog V3: products (Query Products), their variants (Query Variants,
 *   by product) and inventory items (Query Inventory Items);
 * - Catalog V1: products with their variants and stock (Query Products with
 *   includeVariants), which carry stock themselves;
 * - Stores not installed: orders and contacts only.
 * A site moves from V1 to V3 once and never back.
 *
 * Every stream is filtered on `updatedDate` (V1: `lastUpdated`) and sorted
 * oldest change first. V3, eCommerce and contacts page with Wix's cursor,
 * which the checkpoint keeps, so a crash resumes at the next page; a saved
 * cursor Wix no longer accepts restarts that stream from the newest change
 * already read. V1 pages by offset, so after each page the next request
 * starts at the newest change on it, and only a page of records changed at
 * the same instant is paged by offset.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the app holds read permissions only. */
export const WIX_WRITES: WriteAction[] = [
  { integration: "wix", name: "update_inventory", description: "Set the stock quantity of a product variant at a location" },
  { integration: "wix", name: "update_product", description: "Update a product's details or price" },
];

export const WIX_STREAMS = ["products", "inventory", "orders", "contacts"] as const;
export type WixStream = (typeof WIX_STREAMS)[number];
type Step = WixStream | "done";
const STEPS: Step[] = [...WIX_STREAMS, "done"];
export type WixCatalog = "v1" | "v3" | "none";

/** Each incremental pass starts this long before the newest change the last one saw. */
export const WIX_OVERLAP_MS = 5 * 60_000;
/** Where the catalog, stock and contacts start: everything. */
const CATALOG_START = "2000-01-01T00:00:00.000Z";
export const WIX_PAGE_SIZE = 100;
/** Query Variants and Query Inventory Items return up to 1,000 a page. */
export const WIX_LARGE_PAGE_SIZE = 1000;
/** Search Orders leaves out PENDING and REJECTED orders unless asked for them; INITIALIZED never comes back. */
export const WIX_ORDER_STATUSES = ["APPROVED", "CANCELED", "PENDING", "REJECTED"] as const;

/** Where a sync stands. Serialized as the runSync checkpoint. Times are ISO 8601 UTC. */
export interface WixCursor {
  pass: "historical" | "incremental";
  step: Step;
  catalog: WixCatalog;
  /** Wix's cursor for the next page of the current stream, or null for its first page. */
  page: string | null;
  /** Catalog V1 only: the current window starts at this time, `offset` products in. */
  after: string | null;
  offset: number;
  /** Where each stream's pass started. */
  since: Record<WixStream, string>;
  /** The newest change seen per stream. */
  latest: Partial<Record<WixStream, string>>;
}

export interface WixConnectorOptions extends WixClientOptions {
  /** CUSTOMER_REF_KEY: keys the customer references. */
  customerKey: string;
  /** Years of order history the first import reads. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: WixClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isIso = (t: unknown): t is string => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t));
/** Wix's cursors are opaque base64-ish tokens of up to 16,000 characters. */
const PAGE_TOKEN = /^[A-Za-z0-9._~+/=-]{1,16000}$/;
const MAX_CHECKPOINT = 20_000;
const MAX_OFFSET = 1_000_000;
const MAX_VARIANT_PAGES = 1000;
const shift = (t: string, ms: number) => new Date(Date.parse(t) + ms).toISOString();

export function parseWixCursor(raw: string | null): WixCursor | null {
  if (raw === null) return null;
  const fail = () => new Error("Wix checkpoint is not in the expected shape");
  if (typeof raw !== "string" || raw.length > MAX_CHECKPOINT) throw fail();
  let c: WixCursor;
  try {
    c = JSON.parse(raw) as WixCursor;
  } catch {
    throw fail();
  }
  const streamTimes = (value: unknown, all: boolean) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([k, v]) => (WIX_STREAMS as readonly string[]).includes(k) && isIso(v)) &&
    (!all || WIX_STREAMS.every((s) => Object.hasOwn(value, s)));
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !STEPS.includes(c.step) ||
    (c.catalog !== "v1" && c.catalog !== "v3" && c.catalog !== "none") ||
    !(c.page === null || (typeof c.page === "string" && PAGE_TOKEN.test(c.page))) ||
    !(c.after === null || isIso(c.after)) ||
    !Number.isSafeInteger(c.offset) ||
    c.offset < 0 ||
    c.offset > MAX_OFFSET ||
    !streamTimes(c.since, true) ||
    !streamTimes(c.latest, false)
  ) {
    throw fail();
  }
  return c;
}

/** The steps a catalog has: V1 keeps stock on its products, and a site without Stores has neither. */
function stepsFor(catalog: WixCatalog): Step[] {
  if (catalog === "v3") return STEPS;
  if (catalog === "v1") return STEPS.filter((s) => s !== "inventory");
  return STEPS.filter((s) => s !== "products" && s !== "inventory");
}

/** Wix's cursor for the next page, or null at the end. Query Inventory Items sends no hasNext, only a next cursor. */
function nextPage(body: WixRecord): string | null {
  const meta = (body.pagingMetadata ?? body.metadata) as { hasNext?: unknown; cursors?: { next?: unknown } } | undefined;
  if (meta?.hasNext === false) return null;
  const next = meta?.cursors?.next;
  return typeof next === "string" && PAGE_TOKEN.test(next) ? next : null;
}

const records = (value: unknown): WixRecord[] => (Array.isArray(value) ? value.filter((r): r is WixRecord => r !== null && typeof r === "object" && !Array.isArray(r)) : []);

export function wixConnector(options: WixConnectorOptions): Connector {
  const customerKey = checkWixCustomerKey(options.customerKey);
  const client = options.client ?? wixClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  const lookbackHours = options.incrementalLookbackHours ?? 48;
  const ctx = (receivedAt: string): WixContext => ({ receivedAt, customerRef: (id) => wixCustomerRef(customerKey, client.instanceId, id) });

  async function catalogVersion(): Promise<WixCatalog> {
    const body = await client.read("catalogVersion");
    if (body.catalogVersion === "V3_CATALOG") return "v3";
    if (body.catalogVersion === "V1_CATALOG") return "v1";
    if (body.catalogVersion === "STORES_NOT_INSTALLED") return "none";
    throw new WixApiError("Wix answered with a catalog version the connector doesn't know", 200, "unknown_catalog_version");
  }

  function first(catalog: WixCatalog): Step {
    return stepsFor(catalog)[0]!;
  }

  async function startHistorical(): Promise<WixCursor> {
    const start = new Date(now());
    start.setUTCFullYear(start.getUTCFullYear() - historyYears);
    const catalog = await catalogVersion();
    return {
      pass: "historical",
      step: first(catalog),
      catalog,
      page: null,
      after: CATALOG_START,
      offset: 0,
      since: { products: CATALOG_START, inventory: CATALOG_START, orders: start.toISOString(), contacts: CATALOG_START },
      latest: {},
    };
  }

  async function startIncremental(previous: WixCursor | null): Promise<WixCursor> {
    const fallback = new Date(now().getTime() - lookbackHours * 3_600_000).toISOString();
    const since = Object.fromEntries(
      WIX_STREAMS.map((s) => {
        const seen = previous?.latest[s];
        // Nothing seen yet: the last pass's start, or the lookback.
        return [s, seen ? shift(seen, -WIX_OVERLAP_MS) : (previous?.since[s] ?? fallback)];
      }),
    ) as Record<WixStream, string>;
    const catalog = await catalogVersion();
    const step = first(catalog);
    return { pass: "incremental", step, catalog, page: null, after: step === "done" ? null : since[step as WixStream], offset: 0, since, latest: { ...previous?.latest } };
  }

  /** The filter and sort that start a stream's window. */
  const window = (field: string, from: string) => ({ filter: { [field]: { $gte: from } }, sort: [{ fieldName: field, order: "ASC" }] });

  /** Reads every variant of a page of V3 products, all pages. */
  async function variantsOf(productIds: string[]): Promise<WixRecord[]> {
    if (!productIds.length) return [];
    const all: WixRecord[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_VARIANT_PAGES; i++) {
      const body = await client.read("variantsV3", {
        query: cursor ? { cursorPaging: { limit: WIX_LARGE_PAGE_SIZE, cursor } } : { filter: { "productData.productId": { $in: productIds } }, cursorPaging: { limit: WIX_LARGE_PAGE_SIZE } },
      });
      all.push(...records(body.variants));
      cursor = nextPage(body);
      if (!cursor) return all;
    }
    throw new WixApiError("Wix kept sending pages of variants; stopping", 200, "too_many_pages");
  }

  /** One page of a cursor-paged stream: its records and the next cursor. */
  async function cursorPage(step: Exclude<WixStream, "products"> | "productsV3", cursor: WixCursor): Promise<{ items: WixRecord[]; next: string | null; field: string }> {
    const from = cursor.since[step === "productsV3" ? "products" : step];
    const paged = (limit: number) => (cursor.page ? { cursorPaging: { limit, cursor: cursor.page } } : null);
    let body: WixRecord;
    let items: WixRecord[];
    if (step === "orders") {
      const page = paged(WIX_PAGE_SIZE);
      body = await client.read("orders", {
        search: page ?? { filter: { ...window("updatedDate", from).filter, status: { $in: [...WIX_ORDER_STATUSES] } }, sort: window("updatedDate", from).sort, cursorPaging: { limit: WIX_PAGE_SIZE } },
      });
      items = records(body.orders);
    } else if (step === "contacts") {
      body = await client.read("contacts", { query: paged(WIX_PAGE_SIZE) ?? { ...window("updatedDate", from), cursorPaging: { limit: WIX_PAGE_SIZE } } });
      items = records(body.contacts);
    } else if (step === "inventory") {
      body = await client.read("inventoryV3", { query: paged(WIX_LARGE_PAGE_SIZE) ?? { ...window("updatedDate", from), cursorPaging: { limit: WIX_LARGE_PAGE_SIZE } } });
      items = records(body.inventoryItems);
    } else {
      body = await client.read("productsV3", { query: paged(WIX_PAGE_SIZE) ?? { ...window("updatedDate", from), cursorPaging: { limit: WIX_PAGE_SIZE } } });
      items = records(body.products);
    }
    return { items, next: nextPage(body), field: "updatedDate" };
  }

  /** The next step after this one, for the cursor's catalog. */
  function advance(cursor: WixCursor, step: WixStream, latest: WixCursor["latest"]): WixCursor {
    const steps = stepsFor(cursor.catalog);
    const next = steps[steps.indexOf(step) + 1] ?? "done";
    return { ...cursor, step: next, page: null, after: next === "done" ? null : cursor.since[next as WixStream], offset: 0, latest };
  }

  function newest(items: WixRecord[], field: string, latest: WixCursor["latest"], stream: WixStream): { latest: WixCursor["latest"]; top: string | undefined } {
    let top: string | undefined;
    for (const r of items) {
      const t = wixTime(r[field]);
      if (t && (!top || t > top)) top = t;
    }
    const merged = { ...latest };
    if (top && (!merged[stream] || top > merged[stream]!)) merged[stream] = top;
    return { latest: merged, top };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWixCursor(context.cursor);
    let cursor: WixCursor;
    if (mode === "historical") {
      // A finished import stays finished (its step is done); an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : await startHistorical();
    } else {
      cursor = saved?.pass === "incremental" && saved.step !== "done" ? saved : await startIncremental(saved);
    }

    while (cursor.step !== "done") {
      const step = cursor.step;
      const at = now().toISOString();
      let events: WixBrainEvent[] = [];

      if (step === "products" && cursor.catalog === "v1") {
        const after = cursor.after ?? cursor.since.products;
        const body = await client.read("productsV1", {
          includeVariants: true,
          query: { filter: JSON.stringify({ lastUpdated: { $gte: after } }), sort: JSON.stringify([{ lastUpdated: "asc" }]), paging: { limit: WIX_PAGE_SIZE, offset: cursor.offset } },
        });
        const items = records(body.products);
        events = items.flatMap((p) => wixProductV1Events(p, ctx(at)));
        const { latest, top } = newest(items, "lastUpdated", cursor.latest, "products");
        if (items.length < WIX_PAGE_SIZE) cursor = advance(cursor, "products", latest);
        else if (top && top > after) cursor = { ...cursor, after: top, offset: 0, latest };
        // A page of products changed at the same instant: page on by offset.
        else cursor = { ...cursor, offset: cursor.offset + WIX_PAGE_SIZE, latest };
        yield { events, cursor: JSON.stringify(cursor) };
        continue;
      }

      const kind = step === "products" ? "productsV3" : step;
      let result: { items: WixRecord[]; next: string | null; field: string };
      try {
        result = await cursorPage(kind, cursor);
      } catch (error) {
        // A saved cursor Wix no longer takes: start the stream again from the newest change already read.
        if (!(error instanceof WixApiError) || error.status !== 400 || !cursor.page) throw error;
        const restart = cursor.latest[step] ?? cursor.since[step];
        // No newer change to restart from: going round again would read the same page forever.
        if (restart <= cursor.since[step]) throw error;
        cursor = { ...cursor, page: null, since: { ...cursor.since, [step]: restart } };
        result = await cursorPage(kind, cursor);
      }
      const c = ctx(at);
      if (step === "products") {
        const ids = result.items.flatMap((p) => wixId(p.id) ?? []);
        const variants = await variantsOf(ids);
        events = result.items.flatMap((p) => wixProductV3Events(p, variants, c));
      } else if (step === "inventory") {
        events = result.items.flatMap((i) => wixInventoryItemEvents(i, c));
      } else if (step === "orders") {
        events = result.items.flatMap((o) => wixOrderEvents(o, c));
      } else {
        events = result.items.flatMap((r) => wixContactEvent(r, c) ?? []);
      }
      const { latest } = newest(result.items, result.field, cursor.latest, step);
      cursor = result.next ? { ...cursor, page: result.next, latest } : advance(cursor, step, latest);
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "wix",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    handleWebhook: (body) => wixWebhookEvents(body as WixWebhookDelivery, ctx(now().toISOString()), now()),
    writes: WIX_WRITES,
  };
}
