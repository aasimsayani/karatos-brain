import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { NIVODA_ENDPOINTS, NIVODA_PAGE_SIZE, nivodaClient, type NivodaClient, type NivodaClientOptions, type NivodaEnvironment } from "./client.js";
import { delistedEvent, listedEvent, NIVODA_ID, readNivodaItem, unreadableEvent, type NivodaEvent } from "./normalize.js";

/**
 * Nivoda's diamond marketplace: the diamonds a saved search finds, read
 * through Nivoda's GraphQL API as the business's own Nivoda account. Each
 * sync reads every page of the search and compares it with the last one:
 * a diamond that is new or changed is recorded, and one that left is
 * recorded as delisted. Nivoda asks for 30 seconds between requests, so a
 * search of 1,000 diamonds takes about ten minutes to read.
 *
 * The checkpoint keeps each diamond's id, a hash of what was read and how
 * often it has left the search, so an unchanged diamond is never recorded
 * twice and one that comes back is recorded again. When the search changes
 * while it is being read, so fewer diamonds arrive than Nivoda counted, the
 * new and changed ones are kept but none is marked delisted that sync.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const NIVODA_WRITES: WriteAction[] = [
  { integration: "nivoda", name: "create_hold", description: "Put a Nivoda diamond on hold for the business" },
  { integration: "nivoda", name: "create_order", description: "Order a diamond through Nivoda" },
];

/**
 * Where a Nivoda sync stands: each diamond by its Nivoda id. A diamond in
 * the search is the hash of what was last read, followed by ~n once it has
 * left the search n times before; a diamond out of the search is ~n alone.
 */
export type NivodaCursor = Record<string, string>;

interface Seen {
  hash: string | null;
  departures: number;
}

const readEntry = (value: string | undefined): Seen => {
  const [hash = "", departures = "0"] = (value ?? "").split("~");
  return { hash: hash || null, departures: Number(departures) };
};
const writeEntry = ({ hash, departures }: Seen) => `${hash ?? ""}${departures ? `~${departures}` : ""}`;

/** Nivoda pages by offset up to this many diamonds. */
export const NIVODA_MAX_OFFSET = 50_000;

export interface NivodaOptions extends Partial<Pick<NivodaClientOptions, "fetch" | "sleep" | "rateLimitRetries" | "environment">> {
  username: string;
  password: string;
  /** The saved search, as Nivoda's DiamondQuery filter. Every diamond Nivoda offers when empty, which maxStones stops. */
  query?: Record<string, unknown>;
  /** The most diamonds the search may find. Defaults to 1,000; a larger search stops the sync. */
  maxStones?: number;
  /** Events per batch; each batch is one checkpoint. */
  batchSize?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: NivodaClient;
}

export class NivodaSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NivodaSearchError";
  }
}

const ENTRY = /^([0-9a-f]{12}(~[1-9]\d{0,5})?|~[1-9]\d{0,5})$/;

export function parseNivodaCursor(raw: string | null): NivodaCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as NivodaCursor;
  const ok = typeof c === "object" && c !== null && !Array.isArray(c) && Object.entries(c).every(([id, entry]) => NIVODA_ID.test(id) && typeof entry === "string" && ENTRY.test(entry));
  if (!ok) throw new Error("Nivoda checkpoint is not in the expected shape");
  return c;
}

/** Reads NIVODA_QUERY: the saved search as a JSON object, or none. */
export function nivodaQuery(value: string | undefined): Record<string, unknown> {
  if (value === undefined || value.trim() === "") return {};
  let query: unknown;
  try {
    query = JSON.parse(value);
  } catch {
    query = null;
  }
  if (typeof query !== "object" || query === null || Array.isArray(query)) throw new Error('NIVODA_QUERY must be a JSON object, such as {"labgrown":false,"sizes":[{"from":1,"to":2}]}');
  return query as Record<string, unknown>;
}

/** Reads NIVODA_ENVIRONMENT: production unless it says staging. */
export function nivodaEnvironment(value: string | undefined): NivodaEnvironment {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return "production";
  if (!Object.hasOwn(NIVODA_ENDPOINTS, v)) throw new Error("NIVODA_ENVIRONMENT must be production or staging");
  return v as NivodaEnvironment;
}

const positive = (n: number, name: string, most = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isInteger(n) || n < 1 || n > most) throw new Error(`${name} must be a whole number from 1 to ${most.toLocaleString("en-US")}`);
  return n;
};

export function nivodaConnector(options: NivodaOptions): Connector {
  const client = options.client ?? nivodaClient(options);
  const now = options.now ?? (() => new Date());
  const query = options.query ?? {};
  const maxStones = positive(options.maxStones ?? 1_000, "maxStones", NIVODA_MAX_OFFSET);
  const batchSize = positive(options.batchSize ?? 500, "batchSize");

  /** Every page of the search, and whether all Nivoda counted arrived. */
  async function readSearch(): Promise<{ items: unknown[]; complete: boolean }> {
    const items: unknown[] = [];
    let counted: number | null = null;
    let steady = true;
    for (let offset = 0; counted === null || offset < counted; offset += NIVODA_PAGE_SIZE) {
      const page = await client.search(query, offset);
      if (counted !== null && page.totalCount !== counted) steady = false;
      if (page.totalCount > maxStones) throw new NivodaSearchError(`the Nivoda search finds ${page.totalCount} diamonds, more than the ${maxStones} allowed; narrow NIVODA_QUERY or raise NIVODA_MAX_STONES`);
      counted = page.totalCount;
      items.push(...page.items);
      if (page.items.length === 0) break;
    }
    return { items, complete: steady && items.length === counted };
  }

  async function* pages(context: SyncContext): AsyncIterable<SourceBatch> {
    const known: NivodaCursor = { ...parseNivodaCursor(context.cursor) };
    const { items, complete } = await readSearch();
    if (items.length === 0 && Object.values(known).some((v) => readEntry(v).hash !== null)) {
      throw new NivodaSearchError("Nivoda found no diamonds for the search; nothing was marked delisted. Check NIVODA_QUERY and the account on Nivoda");
    }
    const receivedAt = now().toISOString();
    const seen = new Set<string>();
    let events: NivodaEvent[] = [];
    const flush = () => {
      const batch = { events, cursor: JSON.stringify(known) };
      events = [];
      return batch;
    };

    for (const [index, item] of items.entries()) {
      const read = readNivodaItem(item, index + 1);
      if (read.kind === "unreadable") events.push(unreadableEvent(read, receivedAt));
      // A diamond the search moved across a page boundary arrives twice; the first is kept.
      else if (!seen.has(read.id)) {
        seen.add(read.id);
        const before = readEntry(known[read.id]);
        if (before.hash !== read.hash) {
          events.push(listedEvent(read, before.departures, receivedAt));
          known[read.id] = writeEntry({ hash: read.hash, departures: before.departures });
        }
      }
      if (events.length >= batchSize) yield flush();
    }
    if (complete) {
      for (const [id, value] of Object.entries(known)) {
        const before = readEntry(value);
        if (seen.has(id) || before.hash === null) continue;
        events.push(delistedEvent(id, before.departures + 1, receivedAt));
        known[id] = writeEntry({ hash: null, departures: before.departures + 1 });
        if (events.length >= batchSize) yield flush();
      }
    }
    if (events.length) yield flush();
  }

  return {
    source: "nivoda",
    historicalImport: (context) => pages(context),
    incrementalSync: (context) => pages(context),
    writes: NIVODA_WRITES,
  };
}
