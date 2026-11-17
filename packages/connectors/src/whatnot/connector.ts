import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { isWhatnotCursor, whatnotClient, type WhatnotClient, type WhatnotClientOptions, type WhatnotPage } from "./client.js";
import { whatnotOrderEvents, whatnotOrderId, whatnotProductEvents, whatnotId, whatnotTime, type WhatnotEvent } from "./normalize.js";

/**
 * Whatnot: a seller's live-show and marketplace orders, with their sales
 * and cancellations, and the seller's products with each variant's price
 * and stock, for the sales and inventory departments.
 *
 * Whatnot's lists filter by nothing: no created-since or updated-since, only
 * a cursor and a direction. So:
 *
 * - The historical import reads every order, oldest first, each with all
 *   its line items, then every product, oldest first, with its variants.
 *   It stops for good once done.
 * - Each later sync reads orders newest first and stops after a page where
 *   every order was created more than 60 days ago, since orders keep
 *   changing after they are made, then reads every product again (sellers
 *   list few). Records that didn't change come back as duplicates. A
 *   change to an order older than that isn't seen until the next
 *   historical import.
 *
 * Each page is one batch, and the checkpoint keeps Whatnot's cursor for the
 * next page, so a sync that stops resumes at the same page.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, the token has no write scope, and the client has no way to send it. */
export const WHATNOT_WRITES: WriteAction[] = [{ integration: "whatnot", name: "cancel_order", description: "Cancel a Whatnot order", kind: "update", approval: "each", dailyCap: 5 }];

const DAY_MS = 86_400_000;
/** Later syncs read orders created this many days back again, since they change after they are made. */
export const WHATNOT_REVISIT_DAYS = 60;

/** Serialized as the runSync checkpoint. */
export interface WhatnotCursor {
  /** The pass finished: the historical import never runs again, and the next sync starts a fresh pass. */
  done: boolean;
  /** Which list the pass is reading, while it isn't done. */
  step: "orders" | "products" | null;
  /** Whatnot's cursor for the next page of that list, or null for its first page. */
  page: string | null;
}

export interface WhatnotOptions extends WhatnotClientOptions {
  now?: () => Date;
  /** Replaced in tests. */
  client?: WhatnotClient;
}

const MESSAGE = "Whatnot checkpoint is not in the expected shape";

export function parseWhatnotCursor(raw: string | null): WhatnotCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "done,page,step") throw new Error(MESSAGE);
  const doneOk = r.done === true && r.step === null && r.page === null;
  const openOk = r.done === false && (r.step === "orders" || r.step === "products") && (r.page === null || isWhatnotCursor(r.page));
  if (!doneOk && !openOk) throw new Error(MESSAGE);
  return { done: r.done as boolean, step: r.step as WhatnotCursor["step"], page: r.page as string | null };
}

const FINISHED: WhatnotCursor = { done: true, step: null, page: null };
const START: WhatnotCursor = { done: false, step: "orders", page: null };

export function whatnotConnector(options: WhatnotOptions): Connector {
  const client = options.client ?? whatnotClient(options);
  const now = options.now ?? (() => new Date());

  /** Every page of a list that hangs off one record, such as an order's items. */
  async function all(list: (cursor: string | null) => Promise<WhatnotPage>): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let cursor: string | null = null; ; ) {
      const page = await list(cursor);
      rows.push(...page.data);
      if (page.nextCursor === null) return rows;
      cursor = page.nextCursor;
    }
  }

  async function orderEvents(order: unknown, receivedAt: string): Promise<WhatnotEvent[]> {
    const id = whatnotOrderId((order as { id?: unknown } | null)?.id);
    // An order without an id can't have its items read; it is dead-lettered with none.
    const items = id ? await all((cursor) => client.orderItems(id, cursor)) : [];
    return whatnotOrderEvents(order, items, receivedAt).map((r) => r.event);
  }

  async function productEvents(product: unknown, receivedAt: string): Promise<WhatnotEvent[]> {
    const id = whatnotId((product as { id?: unknown } | null)?.id);
    const variants = id ? await all((cursor) => client.variants(id, cursor)) : [];
    return whatnotProductEvents(product, variants, receivedAt).map((r) => r.event);
  }

  async function* pass(start: WhatnotCursor, incremental: boolean): AsyncIterable<SourceBatch> {
    let state = start;
    const edge = now().getTime() - WHATNOT_REVISIT_DAYS * DAY_MS;
    while (state.step === "orders") {
      const page = await client.orders({ cursor: state.page, reverse: incremental });
      const receivedAt = now().toISOString();
      const events: WhatnotEvent[] = [];
      for (const order of page.data) events.push(...(await orderEvents(order, receivedAt)));
      // Newest first, a page of orders all created before the edge means the rest are older still.
      const pastEdge =
        incremental &&
        page.data.every((o) => {
          const created = whatnotTime((o as { created_at?: unknown } | null)?.created_at);
          return created !== undefined && Date.parse(created) < edge;
        });
      state = page.nextCursor === null || pastEdge ? { done: false, step: "products", page: null } : { done: false, step: "orders", page: page.nextCursor };
      yield { events, cursor: JSON.stringify(state) };
    }
    while (state.step === "products") {
      const page = await client.products({ cursor: state.page, reverse: false });
      const receivedAt = now().toISOString();
      const events: WhatnotEvent[] = [];
      for (const product of page.data) events.push(...(await productEvents(product, receivedAt)));
      state = page.nextCursor === null ? FINISHED : { done: false, step: "products", page: page.nextCursor };
      yield { events, cursor: JSON.stringify(state) };
    }
  }

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWhatnotCursor(context.cursor);
    // A finished import has no list left to read, so it yields nothing.
    yield* pass(saved ?? START, false);
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWhatnotCursor(context.cursor);
    yield* pass(saved && !saved.done ? saved : START, true);
  }

  return { source: "whatnot", historicalImport, incrementalSync, writes: WHATNOT_WRITES };
}
