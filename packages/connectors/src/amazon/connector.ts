import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { AMAZON_SETTLE_MS, AMAZON_TRANSACTION_RANGE_DAYS, amazonClient, amazonTimeMs, type AmazonClient, type AmazonClientOptions } from "./client.js";
import { amazonOrderEvents, amazonPage, amazonStockEvent, amazonTransactionEvent, type AmazonBrainEvent, type AmazonContext } from "./normalize.js";

/**
 * Reads, in turn, the orders Amazon last updated in a range of time, the
 * transactions it posted in the same range (in steps of up to 179 days,
 * since Amazon answers nothing for a wider one), and the marketplace's
 * stock in Amazon's warehouses as it stands now. The range is the last two
 * years on the historical import, and on each incremental pass the time
 * since the last pass ended, less AMAZON_OVERLAP_DAYS, since Amazon can
 * post a transaction up to two days late. Unchanged records are duplicates.
 */

/** Declared so they can be gated and audited; none runs while writes are off, and the client sends only GETs. */
export const AMAZON_WRITES: WriteAction[] = [
  { integration: "amazon", name: "update_listing_quantity", description: "Change how many units a merchant-fulfilled listing offers", kind: "update", approval: "each", dailyCap: 20 },
  { integration: "amazon", name: "update_listing_price", description: "Change a listing's price", kind: "update", approval: "each", dailyCap: 10 },
];

/** The historical import reads this many days. */
export const AMAZON_HISTORY_DAYS = 731;
/** An incremental pass with no earlier pass to follow reads this many days. */
export const AMAZON_FIRST_PASS_DAYS = 7;
/** Each incremental pass starts this many days before the last pass ended. */
export const AMAZON_OVERLAP_DAYS = 2;

export const AMAZON_STEPS = ["orders", "transactions", "inventory", "done"] as const;
type Step = (typeof AMAZON_STEPS)[number];

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface AmazonCursor {
  pass: "historical" | "incremental";
  step: Step;
  /** The list's token for the next page, or null for the first. */
  token: string | null;
  /** The pass's range, ISO times in UTC, fixed when the pass starts. */
  after: string;
  before: string;
  /** Where the transactions step's current range of up to 179 days starts. */
  window: string;
}

export interface AmazonConnectorOptions extends AmazonClientOptions {
  /** Injected client, for tests; built from the other options otherwise. */
  client?: AmazonClient;
}

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function parseAmazonCursor(raw: string | null): AmazonCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as AmazonCursor;
  const after = amazonTimeMs(c?.after);
  const before = amazonTimeMs(c?.before);
  const window = amazonTimeMs(c?.window);
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    !AMAZON_STEPS.includes(c.step) ||
    (c.token !== null && typeof c.token !== "string") ||
    (c.token !== null && c.step === "done") ||
    // A time that can't be read fails every comparison: NaN < x is false.
    !(after < before) ||
    Number.isNaN(window) ||
    window < after ||
    window >= before
  ) {
    throw new Error("Amazon checkpoint is not in the expected shape");
  }
  return c;
}

export function amazonConnector(options: AmazonConnectorOptions): Connector {
  const client = options.client ?? amazonClient(options);
  const now = options.now ?? Date.now;

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseAmazonCursor(context.cursor);
    const at = now();
    const before = at - AMAZON_SETTLE_MS;
    const earliest = at - AMAZON_HISTORY_DAYS * DAY_MS;
    let cursor: AmazonCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : { pass: "historical", step: "orders", token: null, after: iso(earliest), before: iso(before), window: iso(earliest) };
    } else if (saved && saved.step !== "done" && saved.pass === "incremental") {
      cursor = saved;
    } else {
      // Follow on from the last finished pass, whichever kind it was.
      const follow = saved?.step === "done" ? amazonTimeMs(saved.before) - AMAZON_OVERLAP_DAYS * DAY_MS : at - AMAZON_FIRST_PASS_DAYS * DAY_MS;
      const after = Math.max(Math.min(follow, before - 60_000), earliest);
      cursor = { pass: "incremental", step: "orders", token: null, after: iso(after), before: iso(before), window: iso(after) };
    }
    // A stock page token lasts 30 seconds, so a resumed stock step starts over; its counts are duplicates.
    if (cursor.step === "inventory") cursor = { ...cursor, token: null };

    while (cursor.step !== "done") {
      const ctx: AmazonContext = { receivedAt: new Date(now()).toISOString() };
      let events: AmazonBrainEvent[];
      let next: AmazonCursor;
      if (cursor.step === "orders") {
        const page = amazonPage(await client.orders({ after: cursor.after, before: cursor.before }, cursor.token), "orders");
        events = page.items.flatMap((o) => amazonOrderEvents(o, ctx));
        next = page.next ? { ...cursor, token: page.next } : { ...cursor, step: "transactions", token: null, window: cursor.after };
      } else if (cursor.step === "transactions") {
        const end = Math.min(amazonTimeMs(cursor.window) + AMAZON_TRANSACTION_RANGE_DAYS * DAY_MS, amazonTimeMs(cursor.before));
        const page = amazonPage(await client.transactions({ after: cursor.window, before: iso(end) }, cursor.token), "transactions");
        events = page.items.flatMap((t) => amazonTransactionEvent(t, ctx) ?? []);
        if (page.next) next = { ...cursor, token: page.next };
        else if (end < amazonTimeMs(cursor.before)) next = { ...cursor, token: null, window: iso(end) };
        else next = { ...cursor, step: "inventory", token: null, window: cursor.after };
      } else {
        const page = amazonPage(await client.inventory(cursor.token), "inventory");
        events = page.items.flatMap((s) => amazonStockEvent(s, ctx) ?? []);
        next = page.next ? { ...cursor, token: page.next } : { ...cursor, step: "done", token: null, window: cursor.after };
      }
      cursor = next;
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "amazon",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: AMAZON_WRITES,
  };
}
