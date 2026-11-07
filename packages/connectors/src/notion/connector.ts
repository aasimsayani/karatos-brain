import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { NOTION_ID, NotionApiError, NotionConfigError, notionClient, notionId, type NotionClient, type NotionClientOptions } from "./client.js";
import { notionPageEvents, notionSafeProperties, notionSource, notionSourceEvents, type NotionBrainEvent } from "./normalize.js";

/**
 * Notion: the databases a store tracks repairs, custom orders and buying in.
 * Each pass reads every data source shared with the connection (or the
 * ones NOTION_DATA_SOURCE_IDS names), each one's properties, then its pages,
 * reading only the properties that hold no free text.
 *
 * The historical import reads pages edited in the last five years. Later
 * syncs ask Notion only for pages edited since the last pass started, less
 * five minutes of overlap. Pages are read oldest edit first and each
 * checkpoint keeps the latest edit time read, so a resumed sync asks again
 * from there instead of keeping Notion's page cursor. Notion stops one
 * query at 10,000 pages; the connector then asks again from the latest edit
 * time read. Notion doesn't report deleted pages to a query, so a deleted
 * page is simply no longer read.
 *
 * Notion's API can't say what a connection may do, so make it with the Read
 * content capability only. The client sends only reads either way.
 */

/** Declared so they can be gated and audited; none runs while writes are off. */
export const NOTION_WRITES: WriteAction[] = [
  { integration: "notion", name: "create_page", description: "Create a page in a database, such as a new repair or custom order" },
  { integration: "notion", name: "update_page", description: "Change a page's properties, such as a repair's status" },
];

/** Each incremental pass starts this long before the previous one did, so a change saved mid-pass is never missed. */
export const NOTION_OVERLAP_MS = 5 * 60_000;

/** Where a sync stands. Serialized as the runSync checkpoint. */
export interface NotionCursor {
  pass: "historical" | "incremental";
  /** Data sources still to read, the current one first. Empty once the pass is done. */
  sources: string[];
  /** The latest edit time read from the current data source, or null when it hasn't been started. */
  from: string | null;
  /** ISO times: a pass keeps pages edited from `since`, and the next pass starts at `nextFrom`. */
  since: string;
  nextFrom: string;
}

export interface NotionOptions extends Partial<Pick<NotionClientOptions, "fetch" | "sleep" | "rateLimitRetries">> {
  token: string;
  /** Read only these data sources, by id. Every data source shared with the connection otherwise. */
  dataSources?: string[] | undefined;
  /** Years of history the first import reads. Defaults to 5. */
  historyYears?: number;
  /** How far back an incremental sync with no checkpoint looks. Defaults to 24 hours. */
  incrementalLookbackHours?: number;
  now?: () => Date;
  /** Replaced in tests. */
  client?: NotionClient;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Bounds what a checkpoint can hold. */
const MAX_SOURCES = 1000;
const isTime = (t: unknown) => typeof t === "string" && ISO.test(t) && !Number.isNaN(Date.parse(t)) && new Date(t).toISOString() === t;

export function parseNotionCursor(raw: string | null): NotionCursor | null {
  if (raw === null) return null;
  let c: NotionCursor | null;
  try {
    c = JSON.parse(raw) as NotionCursor | null;
  } catch {
    c = null;
  }
  const ok =
    typeof c === "object" &&
    c !== null &&
    (c.pass === "historical" || c.pass === "incremental") &&
    Array.isArray(c.sources) &&
    c.sources.length <= MAX_SOURCES &&
    c.sources.every((s) => typeof s === "string" && DASHED.test(s)) &&
    (c.from === null || isTime(c.from)) &&
    isTime(c.since) &&
    isTime(c.nextFrom) &&
    // An edit time only makes sense inside a data source still being read.
    (c.from === null || c.sources.length > 0);
  if (!ok || !c) throw new Error("Notion checkpoint is not in the expected shape");
  const { pass, sources, from, since, nextFrom } = c;
  return { pass, sources, from, since, nextFrom };
}

const positive = (n: number, name: string) => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

const IDS_ERROR = "NOTION_DATA_SOURCE_IDS must be Notion data source ids, separated by commas";

/** Reads NOTION_DATA_SOURCE_IDS: data source ids separated by commas or spaces, with or without dashes. */
export function parseNotionDataSources(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const raw = value.split(/[\s,]+/).filter(Boolean);
  if (raw.length > MAX_SOURCES || !raw.every((s) => NOTION_ID.test(s))) throw new Error(IDS_ERROR);
  return [...new Set(raw.map((s) => notionId(s)!))];
}

export function notionConnector(options: NotionOptions): Connector {
  if (options.dataSources !== undefined && (options.dataSources.length === 0 || options.dataSources.length > MAX_SOURCES || !options.dataSources.every((s) => NOTION_ID.test(s)))) throw new Error(IDS_ERROR);
  const configured = options.dataSources && [...new Set(options.dataSources.map((s) => notionId(s)!))];
  const client = options.client ?? notionClient(options);
  const now = options.now ?? (() => new Date());
  const historyYears = positive(options.historyYears ?? 5, "historyYears");
  const lookbackHours = positive(options.incrementalLookbackHours ?? 24, "incrementalLookbackHours");

  /** Every data source shared with the connection. */
  async function listSources(): Promise<string[]> {
    const out = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await client.dataSources(cursor);
      for (const s of page.data) {
        const id = s.object === "data_source" ? notionId(s.id) : undefined;
        if (id && out.size < MAX_SOURCES) out.add(id);
      }
      cursor = page.next;
    } while (cursor);
    return [...out];
  }

  async function start(mode: "historical" | "incremental", saved: NotionCursor | null, at: Date): Promise<NotionCursor> {
    let since: string;
    if (mode === "historical") {
      const from = new Date(at);
      from.setUTCFullYear(from.getUTCFullYear() - historyYears);
      since = from.toISOString();
    } else {
      since = saved?.nextFrom ?? new Date(at.getTime() - lookbackHours * 3_600_000).toISOString();
    }
    const sources = configured ?? (await listSources());
    return { pass: mode, sources, from: null, since, nextFrom: new Date(at.getTime() - NOTION_OVERLAP_MS).toISOString() };
  }

  async function* pages(mode: "historical" | "incremental", context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseNotionCursor(context.cursor);
    const at = now();
    let c: NotionCursor;
    if (mode === "historical") {
      // A finished import stays finished (no data sources left); an interrupted one resumes.
      if (saved?.pass === "historical" && saved.sources.length === 0) return;
      c = saved?.pass === "historical" ? saved : await start(mode, saved, at);
    } else {
      c = saved?.pass === "incremental" && saved.sources.length > 0 ? saved : await start(mode, saved, at);
    }
    const receivedAt = at.toISOString();
    const cursor = () => JSON.stringify(c);
    const next = () => {
      c = { ...c, sources: c.sources.slice(1), from: null };
    };

    while (c.sources.length > 0) {
      const id = c.sources[0]!;
      let raw: Record<string, unknown>;
      try {
        raw = await client.dataSource(id);
      } catch (error) {
        if (!(error instanceof NotionApiError) || error.status !== 404) throw error;
        // One named in the settings must be shared; one found by search was deleted or unshared part way through.
        if (configured?.includes(id)) throw new NotionConfigError(`NOTION_DATA_SOURCE_IDS names a data source that isn't shared with the connection: ${id}. Share its database with the connection`);
        next();
        continue;
      }
      const source = notionSource(raw);
      if (!source) {
        next();
        continue;
      }
      if (c.from === null) {
        c = { ...c, from: c.since };
        yield { events: notionSourceEvents(source, receivedAt), cursor: cursor() };
      }
      const properties = notionSafeProperties(source).map((p) => p.id);
      if (properties.length === 0) {
        // Nothing in it the connector reads: asking for no properties returns every one.
        next();
        continue;
      }
      let queryFrom = c.from!;
      let page: string | null = null;
      for (;;) {
        const read = await client.pages(id, properties, queryFrom, page);
        const events: NotionBrainEvent[] = read.data.flatMap((p) => notionPageEvents(p, source, receivedAt));
        const latest = events.map((e) => e.occurredAt).filter((t): t is string => t !== undefined).reduce((a, b) => (b > a ? b : a), c.from!);
        c = { ...c, from: latest };
        if (read.next) {
          page = read.next;
          yield { events, cursor: cursor() };
          continue;
        }
        if (!read.complete) {
          // Notion stopped this query at its limit; ask again from the latest edit read.
          if (c.from === queryFrom) throw new NotionApiError(`Notion has more than 10,000 pages in data source ${id} edited at ${queryFrom}, more than one query can read`, 0);
          queryFrom = c.from!;
          page = null;
          yield { events, cursor: cursor() };
          continue;
        }
        next();
        yield { events, cursor: cursor() };
        break;
      }
    }
    // The pass is done: the checkpoint keeps where the next one starts.
    yield { events: [], cursor: cursor() };
  }

  return {
    source: "notion",
    historicalImport: (context) => pages("historical", context),
    incrementalSync: (context) => pages("incremental", context),
    writes: NOTION_WRITES,
  };
}
