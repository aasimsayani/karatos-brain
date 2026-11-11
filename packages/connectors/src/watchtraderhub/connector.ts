import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { isWatchTraderHubCursor, isWatchTraderHubSince, watchTraderHubClient, WatchTraderHubConfigError, type WatchTraderHubClient, type WatchTraderHubClientOptions, type WatchTraderHubPage } from "./client.js";
import { watchTraderHubListingEvents, watchTraderHubOrderEvents, watchTraderHubPartEvents, type WatchTraderHubEvent, type WatchTraderHubRead } from "./normalize.js";

/**
 * WatchTraderHub: a watch dealer's published watch listings and spare parts,
 * with their prices and stock, for inventory, and the orders the dealer's
 * site reports to it, for sales.
 *
 * Each sync first reads GET /me, which confirms the key and that the
 * integration is enabled, then reads every page of the listings, then the
 * parts, then the orders, 250 a page, following next_cursor as `after`.
 *
 * - The historical import reads every row and stops for good once done.
 * - Each later sync reads only rows changed since the last pass began, less
 *   an hour, with `updated_after`; the first one, with no checkpoint, reads
 *   the last 30 days.
 *
 * Each page is one batch, and the checkpoint keeps the list, the cursor for
 * its next page and the pass's window, so a sync that stops resumes at the
 * same page.
 */

/** Declared so it can be gated and audited; it never runs while writes are off, and the client has no way to send it. */
export const WATCHTRADERHUB_WRITES: WriteAction[] = [{ integration: "watchtraderhub", name: "cancel_order", description: "Cancel an order reported to WatchTraderHub", kind: "update", approval: "each", dailyCap: 5 }];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** A later sync with no checkpoint reads rows changed this many days back. */
export const WATCHTRADERHUB_FIRST_WINDOW_DAYS = 30;
/** Each later pass starts this many minutes before the last one began, so a change saved as that pass read is still seen. */
export const WATCHTRADERHUB_OVERLAP_MINUTES = 60;

const STEPS = ["listings", "parts", "orders"] as const;
type Step = (typeof STEPS)[number];

/** Serialized as the runSync checkpoint. */
export interface WatchTraderHubCursor {
  /** The pass finished: the historical import never runs again, and the next sync starts a fresh pass. */
  done: boolean;
  /** Which list the pass is reading, while it isn't done. */
  step: Step | null;
  /** The cursor for that list's next page, or null for its first page. */
  page: string | null;
  /** The pass's updated_after, null to read every row; once done, when that pass began. */
  since: string | null;
  /** When the open pass began; null once done. */
  started: string | null;
}

export interface WatchTraderHubOptions extends WatchTraderHubClientOptions {
  now?: () => Date;
  /** Replaced in tests. */
  client?: WatchTraderHubClient;
}

const MESSAGE = "WatchTraderHub checkpoint is not in the expected shape";

export function parseWatchTraderHubCursor(raw: string | null): WatchTraderHubCursor | null {
  if (raw === null) return null;
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new Error(MESSAGE);
  }
  if (typeof c !== "object" || c === null) throw new Error(MESSAGE);
  const r = c as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "done,page,since,started,step") throw new Error(MESSAGE);
  const doneOk = r.done === true && r.step === null && r.page === null && isWatchTraderHubSince(r.since) && r.started === null;
  const openOk =
    r.done === false &&
    STEPS.includes(r.step as Step) &&
    (r.page === null || isWatchTraderHubCursor(r.page)) &&
    (r.since === null || isWatchTraderHubSince(r.since)) &&
    isWatchTraderHubSince(r.started);
  if (!doneOk && !openOk) throw new Error(MESSAGE);
  return { done: r.done as boolean, step: r.step as Step | null, page: r.page as string | null, since: r.since as string | null, started: r.started as string | null };
}

export function watchTraderHubConnector(options: WatchTraderHubOptions): Connector {
  const client = options.client ?? watchTraderHubClient(options);
  const now = options.now ?? (() => new Date());

  type List = { read: (request: { after: string | null; updatedAfter: string | null }) => Promise<WatchTraderHubPage>; events: (raw: unknown, receivedAt: string) => WatchTraderHubRead[] };
  const lists = new Map<Step, List>([
    ["listings", { read: (r) => client.listings(r), events: watchTraderHubListingEvents }],
    ["parts", { read: (r) => client.parts(r), events: watchTraderHubPartEvents }],
    ["orders", { read: (r) => client.orders(r), events: watchTraderHubOrderEvents }],
  ]);

  /** Confirms the key reaches an enabled integration before any list is read. */
  async function check(): Promise<void> {
    const me = await client.me();
    if (me.is_enabled === false) throw new WatchTraderHubConfigError("the WatchTraderHub integration for WATCHTRADERHUB_API_KEY is disabled; the dealer enables it under Custom Integration, Settings");
  }

  async function* pass(start: WatchTraderHubCursor): AsyncIterable<SourceBatch> {
    await check();
    let state = start;
    while (state.step !== null) {
      const step = state.step;
      const list = lists.get(step)!;
      const page = await list.read({ after: state.page, updatedAfter: state.since });
      const receivedAt = now().toISOString();
      const events: WatchTraderHubEvent[] = page.data.flatMap((row) => list.events(row, receivedAt).map((r) => r.event));
      const next = STEPS[STEPS.indexOf(step) + 1];
      state =
        page.nextCursor !== null
          ? { ...state, page: page.nextCursor }
          : next
            ? { ...state, step: next, page: null }
            : { done: true, step: null, page: null, since: state.started, started: null };
      yield { events, cursor: JSON.stringify(state) };
    }
  }

  const open = (since: string | null): WatchTraderHubCursor => ({ done: false, step: "listings", page: null, since, started: now().toISOString() });

  async function* historicalImport(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWatchTraderHubCursor(context.cursor);
    // A finished import has no list left to read, so it yields nothing.
    if (saved?.done) return;
    yield* pass(saved ?? open(null));
  }

  async function* incrementalSync(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseWatchTraderHubCursor(context.cursor);
    if (saved && !saved.done) return yield* pass(saved);
    const since = saved ? Date.parse(saved.since!) - WATCHTRADERHUB_OVERLAP_MINUTES * MINUTE_MS : now().getTime() - WATCHTRADERHUB_FIRST_WINDOW_DAYS * DAY_MS;
    yield* pass(open(new Date(since).toISOString()));
  }

  return { source: "watchtraderhub", historicalImport, incrementalSync, writes: WATCHTRADERHUB_WRITES };
}
