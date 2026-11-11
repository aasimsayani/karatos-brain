import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { extendClient, isExtendCursor, type ExtendClient, type ExtendClientOptions } from "./client.js";
import { extendContractEvent, extendOrderEvent, type ExtendEvent, type ExtendRead } from "./normalize.js";

/**
 * Extend product protection: the protection plans a store sold with its
 * products, and the orders Extend holds for the store, for sales, repairs
 * and clienteling.
 *
 * Neither of Extend's searches filters by time, and the contract search
 * has no paging. So each pass reads every contract in one request, then
 * every order a page at a time:
 *
 * - The historical import keeps everything it reads, and stops for good
 *   once done.
 * - Each later sync reads everything again but keeps only what Extend
 *   updated since a day before the last pass started (or, the first time,
 *   in the last 30 days); what is older was kept by an earlier pass.
 *   A record whose time doesn't read is always kept, as a dead letter.
 *
 * Each read is one batch, and the checkpoint keeps Extend's order cursor,
 * so a sync that stops resumes at the same page.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and the client has no way to send it. */
export const EXTEND_WRITES: WriteAction[] = [{ integration: "extend", name: "cancel_order", description: "Cancel an Extend order and the protection plans on it", kind: "update", approval: "each", dailyCap: 5 }];

const DAY_MS = 86_400_000;
/** The first later sync, with no checkpoint, keeps what Extend updated in this many days. */
export const EXTEND_WINDOW_DAYS = 30;
/** Each later sync goes back this far before the last pass started, so a record updated as it ran isn't missed. */
export const EXTEND_OVERLAP_MS = DAY_MS;

/** Serialized as the runSync checkpoint. */
export interface ExtendCursor {
  /** What the pass reads next, or null once it is done. */
  step: "contracts" | "orders" | null;
  /** Extend's cursor for the next page of orders, or null for the first. */
  page: string | null;
  /** Records updated before this time (ms) are skipped; null keeps everything. */
  since: number | null;
  /** When the pass started (ms). */
  started: number;
}

export interface ExtendOptions extends ExtendClientOptions {
  /** Replaced in tests. */
  client?: ExtendClient;
}

const MESSAGE = "Extend checkpoint is not in the expected shape";
const isTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function parseExtendCursor(raw: string | null): ExtendCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "page,since,started,step") throw new Error(MESSAGE);
  const timesOk = isTime(r.started) && (r.since === null || isTime(r.since));
  const stepOk = (r.step === null && r.page === null) || (r.step === "contracts" && r.page === null) || (r.step === "orders" && (r.page === null || isExtendCursor(r.page)));
  if (!timesOk || !stepOk) throw new Error(MESSAGE);
  return { step: r.step as ExtendCursor["step"], page: r.page as string | null, since: r.since as number | null, started: r.started as number };
}

export function extendConnector(options: ExtendOptions): Connector {
  const client = options.client ?? extendClient(options);
  const now = options.now ?? (() => new Date());

  /** The events to keep: every dead letter, and what was updated at or after `since`. */
  const kept = (reads: ExtendRead[], since: number | null): ExtendEvent[] =>
    reads.filter((r) => since === null || r.updatedAt === undefined || Date.parse(r.updatedAt) >= since).map((r) => r.event);

  async function* pass(start: ExtendCursor): AsyncIterable<SourceBatch> {
    let state = start;
    if (state.step === "contracts") {
      const contracts = await client.contracts();
      const receivedAt = now().toISOString();
      state = { ...state, step: "orders", page: null };
      yield { events: kept(contracts.map((c) => extendContractEvent(c, receivedAt)), state.since), cursor: JSON.stringify(state) };
    }
    while (state.step === "orders") {
      const page = await client.orders(state.page);
      const receivedAt = now().toISOString();
      state = page.nextCursor === null ? { ...state, step: null, page: null } : { ...state, page: page.nextCursor };
      yield { events: kept(page.orders.map((o) => extendOrderEvent(o, receivedAt)), state.since), cursor: JSON.stringify(state) };
    }
  }

  const fresh = (since: number | null): ExtendCursor => ({ step: "contracts", page: null, since, started: now().getTime() });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseExtendCursor(context.cursor);
    // A finished import has nothing left to read, so it yields nothing.
    if (saved?.step === null) return;
    yield* pass(saved ?? fresh(null));
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseExtendCursor(context.cursor);
    if (saved && saved.step !== null) return yield* pass(saved);
    yield* pass(fresh(saved ? Math.max(0, saved.started - EXTEND_OVERLAP_MS) : now().getTime() - EXTEND_WINDOW_DAYS * DAY_MS));
  }

  return { source: "extend", historicalImport, incrementalSync, writes: EXTEND_WRITES };
}
