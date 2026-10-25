import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { CsvError, parseCsv } from "../files/csv.js";
import { IDEX_FEEDS, idexClient, type IdexClient, type IdexClientOptions, type IdexFeed } from "./client.js";
import { delistedEvent, IDEX_ITEM_ID, idexColumns, listedEvent, readIdexRow, unreadableEvent, type IdexEvent } from "./normalize.js";

/**
 * IDEX Online's Onsite feeds: the diamonds a subscriber offers on its own
 * website from the IDEX trading network, with its filters and markups
 * applied. Each sync reads the whole file and compares it with the last
 * one: a stone that is new or changed is recorded, and one that left is
 * recorded as delisted. The natural feed is read by default; the
 * lab-grown feed is a separate IDEX add-on.
 *
 * The checkpoint keeps each stone's item number, a hash of what was read and
 * how often it has left the feed, so a resumed sync carries on where it
 * stopped, an unchanged stone is never recorded twice, and a stone that
 * comes back is recorded again.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const IDEX_WRITES: WriteAction[] = [
  { integration: "idex", name: "upload_listings", description: "Upload or update the business's diamond listings on IDEX" },
  { integration: "idex", name: "request_stone", description: "Ask an IDEX supplier to hold or send a stone" },
];

/**
 * Where an IDEX sync stands: each feed's stones by item number. A stone in
 * the feed is the hash of what was last read, followed by ~n once it has
 * left the feed n times before; a stone out of the feed is ~n alone.
 */
export type IdexCursor = Partial<Record<IdexFeed, Record<string, string>>>;

interface Seen {
  hash: string | null;
  departures: number;
}

const readEntry = (value: string | undefined): Seen => {
  const [hash = "", departures = "0"] = (value ?? "").split("~");
  return { hash: hash || null, departures: Number(departures) };
};
const writeEntry = ({ hash, departures }: Seen) => `${hash ?? ""}${departures ? `~${departures}` : ""}`;

export interface IdexOptions extends Partial<Pick<IdexClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  apiKey: string;
  apiSecret: string;
  /** The feeds to read. The natural feed by default. */
  feeds?: readonly IdexFeed[];
  /** The most stones one feed may hold. Defaults to 50,000; a larger feed stops the sync. */
  maxStones?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: IdexClient;
}

export class IdexFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdexFeedError";
  }
}

const ENTRY = /^([0-9a-f]{12}(~[1-9]\d{0,5})?|~[1-9]\d{0,5})$/;

export function parseIdexCursor(raw: string | null): IdexCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as IdexCursor;
  const ok =
    typeof c === "object" &&
    c !== null &&
    !Array.isArray(c) &&
    Object.entries(c).every(
      ([feed, stones]) => feed in IDEX_FEEDS && typeof stones === "object" && stones !== null && !Array.isArray(stones) && Object.entries(stones).every(([id, hash]) => IDEX_ITEM_ID.test(id) && typeof hash === "string" && ENTRY.test(hash)),
    );
  if (!ok) throw new Error("IDEX checkpoint is not in the expected shape");
  return c;
}

/** Reads IDEX_FEEDS: "natural", "lab_grown" or both, comma-separated. */
export function idexFeeds(value: string | undefined): IdexFeed[] {
  if (value === undefined || value.trim() === "") return ["natural"];
  const feeds = [...new Set(value.split(",").map((f) => f.trim().toLowerCase().replace(/[\s-]+/g, "_")))];
  if (!feeds.every((f) => f in IDEX_FEEDS)) throw new Error(`IDEX_FEEDS must be natural, lab_grown or both, comma-separated`);
  return feeds as IdexFeed[];
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export function idexConnector(options: IdexOptions): Connector {
  const client = options.client ?? idexClient(options);
  const now = options.now ?? (() => new Date());
  const feeds = options.feeds ?? (["natural"] as const);
  if (feeds.length === 0 || !feeds.every((f) => f in IDEX_FEEDS)) throw new Error("feeds must be natural, lab_grown or both");
  const maxStones = positive(options.maxStones ?? 50_000, "maxStones");
  const batchSize = positive(options.batchSize ?? 500, "batchSize");

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const cursor: IdexCursor = { ...parseIdexCursor(context.cursor) };
    for (const feed of feeds) {
      const text = await client.file(feed);
      let table: ReturnType<typeof parseCsv>;
      try {
        table = parseCsv(text);
      } catch (error) {
        if (error instanceof CsvError) throw new IdexFeedError(`the IDEX ${feed} feed isn't a CSV file that reads: ${error.message}`);
        throw error;
      }
      const known = { ...cursor[feed] };
      if (table.rows.length === 0 && Object.values(known).some((v) => readEntry(v).hash !== null)) {
        throw new IdexFeedError(`IDEX sent an empty ${feed} feed; nothing was marked delisted. Check the feed's filters on IDEX`);
      }
      if (table.rows.length === 0) continue;
      if (table.rows.length > maxStones) throw new IdexFeedError(`the IDEX ${feed} feed holds ${table.rows.length} stones, more than the ${maxStones} allowed; narrow its filters on IDEX or raise IDEX_MAX_STONES`);
      const get = idexColumns(table.headers, feed);
      const receivedAt = now().toISOString();
      const seen = new Set<string>();
      let events: IdexEvent[] = [];
      const flush = () => {
        cursor[feed] = { ...known };
        const batch = { events, cursor: JSON.stringify(cursor) };
        events = [];
        return batch;
      };

      for (const row of table.rows) {
        const read = readIdexRow(row, get, feed);
        if (read.kind === "unreadable") events.push(unreadableEvent(feed, read, receivedAt));
        else if (seen.has(read.itemId)) events.push(unreadableEvent(feed, { kind: "unreadable", line: row.line, problems: [`repeats item ${read.itemId}`], hash: read.hash }, receivedAt));
        else {
          seen.add(read.itemId);
          const before = readEntry(known[read.itemId]);
          if (before.hash !== read.hash) {
            events.push(listedEvent(feed, read, before.departures, receivedAt));
            known[read.itemId] = writeEntry({ hash: read.hash, departures: before.departures });
          }
        }
        if (events.length >= batchSize) yield flush();
      }
      for (const [itemId, value] of Object.entries(known)) {
        const before = readEntry(value);
        if (seen.has(itemId) || before.hash === null) continue;
        events.push(delistedEvent(feed, itemId, before.departures + 1, receivedAt));
        known[itemId] = writeEntry({ hash: null, departures: before.departures + 1 });
        if (events.length >= batchSize) yield flush();
      }
      if (events.length) yield flush();
    }
  }

  return {
    source: "idex",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: IDEX_WRITES,
  };
}
