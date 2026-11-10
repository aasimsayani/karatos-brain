import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { LightspeedApiError, LIGHTSPEED_INVENTORY_PAGE, isLightspeedVersion, lightspeedClient, type LightspeedClient, type LightspeedClientOptions, type LightspeedRecord } from "./client.js";
import { checkLightspeedCustomerKey, lightspeedCustomerRef } from "./customer.js";
import {
  lightspeedCustomerEvent,
  lightspeedId,
  lightspeedInventoryEvent,
  lightspeedProductEvent,
  lightspeedProductSku,
  lightspeedSaleEvents,
  lightspeedTime,
  lightspeedVersion,
  type LightspeedBrainEvent,
  type LightspeedContext,
} from "./normalize.js";

/**
 * Lightspeed Retail (X-Series): a store's products, stock per outlet,
 * customers and sales, for the sales, inventory and clienteling
 * departments.
 *
 * Lightspeed pages by version: every change to a record gives it a higher
 * version, and a list asked for "after" a version answers the changes
 * since, lowest first. Each pass reads products, then inventory, then
 * customers, then sales, each from the version the last pass reached, so a
 * pass picks up everything changed since and nothing twice (bar the page a
 * crash interrupted). The checkpoint keeps each list's version.
 *
 * The first import reads every product, stock level and customer, and five
 * years of sales; older sales are skipped as they are read. Lightspeed
 * can't filter by date, so an incremental sync with no checkpoint of its
 * own reads everything once too, and what the import already stored comes
 * back as duplicates.
 *
 * Inventory records name a product, not its SKU. The connector keeps the
 * SKUs of products it has read this run and asks Lightspeed for any it
 * hasn't seen (one GET per product), so stock carries the same SKUs as
 * sales.
 *
 * Read-only: KaratOS never changes anything in Lightspeed.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and no write scope is asked for. */
export const LIGHTSPEED_WRITES: WriteAction[] = [{ integration: "lightspeed", name: "adjust_inventory", description: "Adjust a product's stock level at an outlet" }];

/** The lists a pass reads, in order: products first so stock and sales find their SKUs. */
export const LIGHTSPEED_STREAMS = ["products", "inventory", "customers", "sales"] as const;
export type LightspeedStream = (typeof LIGHTSPEED_STREAMS)[number];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface LightspeedCursor {
  pass: "historical" | "incremental";
  /** Which list the pass is on, by position in LIGHTSPEED_STREAMS; 4 when the pass is done. */
  step: number;
  /** The version each list has been read up to. */
  after: Record<LightspeedStream, number>;
}

export interface LightspeedConnectorOptions extends LightspeedClientOptions {
  /** CUSTOMER_REF_KEY: keys the customer references. */
  customerKey: string;
  /** Years of sales the first import reads. */
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: LightspeedClient;
}

const DONE = LIGHTSPEED_STREAMS.length;
const startAfter = (): Record<LightspeedStream, number> => ({ products: 0, inventory: 0, customers: 0, sales: 0 });

export function parseLightspeedCursor(raw: string | null): LightspeedCursor | null {
  if (raw === null) return null;
  let c: LightspeedCursor | null;
  try {
    c = JSON.parse(raw) as LightspeedCursor | null;
  } catch {
    c = null;
  }
  const after = c && typeof c === "object" ? c.after : undefined;
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    Number.isInteger(c.step) &&
    c.step >= 0 &&
    c.step <= DONE &&
    typeof after === "object" &&
    after !== null &&
    LIGHTSPEED_STREAMS.every((s) => isLightspeedVersion(after[s]));
  if (!ok || !c) throw new Error("Lightspeed checkpoint is not in the expected shape");
  return { pass: c.pass, step: c.step, after: Object.fromEntries(LIGHTSPEED_STREAMS.map((s) => [s, after![s]])) as Record<LightspeedStream, number> };
}

export function lightspeedConnector(options: LightspeedConnectorOptions): Connector {
  const customerKey = checkLightspeedCustomerKey(options.customerKey);
  const client = options.client ?? lightspeedClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = options.historyYears ?? 5;
  if (!Number.isInteger(historyYears) || historyYears < 1) throw new Error("historyYears must be a positive whole number");
  const customerRef = (id: unknown) => lightspeedCustomerRef(customerKey, id);

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseLightspeedCursor(context.cursor);
    // A finished import stays finished; an interrupted pass resumes; a finished incremental pass starts the next from where it got to.
    if (mode === "historical" && saved?.pass === "historical" && saved.step === DONE) return;
    let c: LightspeedCursor = saved?.pass === mode ? (saved.step < DONE ? saved : { ...saved, step: 0 }) : { pass: mode, step: 0, after: startAfter() };
    const at = now();
    const receivedAt = at.toISOString();
    const from = new Date(at);
    from.setUTCFullYear(from.getUTCFullYear() - historyYears);
    const oldest = from.getTime();
    const skus = new Map<string, string | null>();
    const ctx: LightspeedContext = { receivedAt, customerRef, sku: (id) => skus.get(id) ?? lightspeedProductSku(id) };
    const learn = (product: LightspeedRecord) => {
      const id = lightspeedId(product.id);
      if (id) skus.set(id, typeof product.sku === "string" && product.sku.trim() ? product.sku.trim().slice(0, 100) : null);
    };

    while (c.step < DONE) {
      const stream = LIGHTSPEED_STREAMS[c.step]!;
      const after = c.after[stream];
      let events: LightspeedBrainEvent[];
      let next: number | null;
      if (stream === "inventory") {
        const items = await client.inventory(after);
        // Products this run hasn't read are looked up one at a time.
        for (const id of new Set(items.flatMap((i) => lightspeedId(i.product_id) ?? []))) {
          if (skus.has(id)) continue;
          const product = await client.product(id);
          if (product) learn(product);
          else skus.set(id, null);
        }
        events = items.flatMap((i) => lightspeedInventoryEvent(i, ctx) ?? []);
        const versions = items.flatMap((i) => lightspeedVersion(i) ?? []);
        const max = versions.length ? Math.max(...versions) : null;
        if (items.length && (max === null || max <= after)) throw new LightspeedApiError("Lightspeed inventory answered a page without a newer version", 200);
        // A short page is the last.
        next = items.length >= LIGHTSPEED_INVENTORY_PAGE ? max : null;
        if (max !== null) c = { ...c, after: { ...c.after, inventory: max } };
      } else {
        const page = await client.list(stream, after);
        if (stream === "products") page.data.forEach(learn);
        events =
          stream === "products"
            ? page.data.flatMap((p) => lightspeedProductEvent(p, ctx) ?? [])
            : stream === "customers"
              ? page.data.flatMap((p) => lightspeedCustomerEvent(p, ctx) ?? [])
              : page.data
                  .filter((s) => {
                    // Sales older than the history window are skipped; one with no readable date is kept, so it dead-letters.
                    const date = lightspeedTime(s.date);
                    return date === undefined || Date.parse(date) >= oldest;
                  })
                  .flatMap((s) => lightspeedSaleEvents(s, ctx));
        next = page.max;
        if (page.max !== null) c = { ...c, after: { ...c.after, [stream]: page.max } };
      }
      if (next === null) c = { ...c, step: c.step + 1 };
      yield { events, cursor: JSON.stringify(c) };
    }
  }

  return {
    source: "lightspeed",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: LIGHTSPEED_WRITES,
  };
}
