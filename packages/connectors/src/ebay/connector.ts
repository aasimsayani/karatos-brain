import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { EBAY_HISTORY_YEARS, EBAY_MAX_RANGE_DAYS, ebayClient, ebayTimeMs, type EbayClient, type EbayClientOptions, type EbayOrderField } from "./client.js";
import { ebayPage, ebayPageEvents, type EbayContext } from "./normalize.js";

/**
 * Reads one seller's eBay orders, a month-long window at a time. The
 * historical import reads every order created in the two years getOrders
 * reaches; incremental syncs read the orders changed since the previous pass
 * ended, less EBAY_OVERLAP_MS so nothing saved mid-pass is missed.
 *
 * getOrders pages by offset. An order changed while a window is read can
 * leave it and shift the rest back, so each next page starts
 * EBAY_OFFSET_OVERLAP orders early; orders read twice are duplicates.
 */

/**
 * Declared so they can be gated and audited; none runs while writes are off,
 * and the access token only holds the read scope. Each changes what buyers
 * see or are told, so each needs a named person's approval.
 */
export const EBAY_WRITES: WriteAction[] = [
  { integration: "ebay", name: "set_listing_quantity", description: "Set how many of a piece an eBay listing offers, so a piece sold in the store can't sell again online", kind: "update", approval: "each", dailyCap: 20 },
  { integration: "ebay", name: "set_listing_price", description: "Change the price of an eBay listing", kind: "update", approval: "each", dailyCap: 10 },
  { integration: "ebay", name: "add_tracking", description: "Add a shipment's tracking number to an eBay order", kind: "append", approval: "each", dailyCap: 20 },
];

/** Each incremental pass starts this long before the previous one ended. */
export const EBAY_OVERLAP_MS = 15 * 60_000;
/** Orders each next page re-reads, in case changed orders shifted the rest back. */
export const EBAY_OFFSET_OVERLAP = 20;
/** How far back an incremental sync with no checkpoint looks. */
export const EBAY_INCREMENTAL_LOOKBACK_DAYS = 7;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface EbayCursor {
  pass: "historical" | "incremental";
  done: boolean;
  /** The time the pass filters on: creation for the import, last change for incremental syncs. */
  field: EbayOrderField;
  /** The start of the pass, an ISO time. */
  from: string;
  /** The end of the pass. */
  until: string;
  /** The start of the window being read. */
  windowStart: string;
  /** Orders already read in the window. */
  offset: number;
}

export interface EbayConnectorOptions extends EbayClientOptions {
  historyYears?: number;
  now?: () => Date;
  /** Injected client, for tests; built from the other options otherwise. */
  client?: EbayClient;
}

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function parseEbayCursor(raw: string | null): EbayCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as EbayCursor;
  if (
    !c ||
    (c.pass !== "historical" && c.pass !== "incremental") ||
    typeof c.done !== "boolean" ||
    (c.field !== "creationdate" && c.field !== "lastmodifieddate") ||
    ![c.from, c.until, c.windowStart].every((t) => !Number.isNaN(ebayTimeMs(t))) ||
    // The window's start lies within the pass, which also means the pass doesn't end before it starts.
    ebayTimeMs(c.windowStart) < ebayTimeMs(c.from) ||
    ebayTimeMs(c.windowStart) > ebayTimeMs(c.until) ||
    !Number.isSafeInteger(c.offset) ||
    c.offset < 0
  ) {
    throw new Error("eBay checkpoint is not in the expected shape");
  }
  return c;
}

export function ebayConnector(options: EbayConnectorOptions): Connector {
  const client = options.client ?? ebayClient(options);
  const now = options.now ?? (() => new Date());
  // getOrders reaches back two years at most, so a longer history can't be read.
  const historyYears = Math.min(options.historyYears ?? EBAY_HISTORY_YEARS, EBAY_HISTORY_YEARS);
  /** The oldest time getOrders takes, with a day to spare. */
  const oldest = () => {
    const first = now();
    first.setUTCFullYear(first.getUTCFullYear() - historyYears);
    return first.getTime() + DAY_MS;
  };

  function start(pass: EbayCursor["pass"], field: EbayOrderField, fromMs: number): EbayCursor {
    const until = now().getTime();
    const from = iso(Math.min(Math.max(fromMs, oldest()), until - 1));
    return { pass, done: false, field, from, until: iso(until), windowStart: from, offset: 0 };
  }

  function startIncremental(previous: EbayCursor | null): EbayCursor {
    const from = previous ? ebayTimeMs(previous.until) - EBAY_OVERLAP_MS : now().getTime() - EBAY_INCREMENTAL_LOOKBACK_DAYS * DAY_MS;
    return start("incremental", "lastmodifieddate", from);
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseEbayCursor(context.cursor);
    let cursor: EbayCursor;
    if (mode === "historical") {
      // A finished import stays finished; an interrupted one resumes.
      cursor = saved?.pass === "historical" ? saved : start("historical", "creationdate", oldest());
    } else {
      cursor = saved?.pass === "incremental" && !saved.done ? saved : startIncremental(saved);
    }

    while (!cursor.done) {
      const windowEnd = iso(Math.min(ebayTimeMs(cursor.windowStart) + EBAY_MAX_RANGE_DAYS * DAY_MS, ebayTimeMs(cursor.until)));
      const page = ebayPage(await client.orders({ field: cursor.field, from: cursor.windowStart, until: windowEnd, offset: cursor.offset }));
      const ctx: EbayContext = { receivedAt: now().toISOString() };
      const events = ebayPageEvents(page, ctx);
      const read = cursor.offset + page.orders.length;
      if (page.orders.length && read < page.total) {
        // Never back to where this page started, so paging always moves on.
        cursor = { ...cursor, offset: Math.max(read - EBAY_OFFSET_OVERLAP, cursor.offset + 1) };
      } else if (windowEnd < cursor.until) {
        cursor = { ...cursor, windowStart: windowEnd, offset: 0 };
      } else {
        cursor = { ...cursor, done: true, windowStart: cursor.from, offset: 0 };
      }
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  return {
    source: "ebay",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: EBAY_WRITES,
  };
}
