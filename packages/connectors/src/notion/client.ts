/**
 * A small client for Notion's API: the data sources (database tables) a
 * connection can see, each one's properties, and its pages. It sends only
 * three requests, to Notion's fixed address, with bodies it builds itself:
 * a search for data sources, a data source's schema, and a query of its
 * pages. Search and query are POSTs in Notion's API, but both only read.
 *
 * Every query names the properties it wants with filter_properties, by id.
 * Notion returns every property when none are named, so a query naming none
 * is never sent, and any property that comes back unasked is dropped.
 */

export const NOTION_API = "https://api.notion.com/v1";
/** The API version the client is written against, sent on every request. */
export const NOTION_VERSION = "2026-03-11";
/** Notion's largest page. */
export const NOTION_PAGE_SIZE = 100;
/** The most properties one query names. */
export const NOTION_MAX_PROPERTIES = 100;
const MAX_RETRY_AFTER_S = 60;
/** Notion's ids are UUIDs, written with or without dashes. */
export const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_=+/-]{1,512}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A Notion id in its dashed, lowercase form, or undefined when it isn't one. */
export function notionId(value: unknown): string | undefined {
  if (typeof value !== "string" || !NOTION_ID.test(value)) return undefined;
  const hex = value.replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A property id as Notion writes it (URL-encoded), decoded, or undefined when it doesn't read as one. */
export function notionPropertyId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return /^[\x21-\x7e]{1,100}$/.test(decoded) ? decoded : undefined;
}

export interface NotionClientOptions {
  /** An internal connection's secret or an OAuth access token. Sent to Notion only, and never logged or shown. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class NotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionConfigError";
  }
}

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export interface NotionPage {
  data: Record<string, unknown>[];
  /** The cursor for the next page, or null on the last page. */
  next: string | null;
}

export interface NotionQueryPage extends NotionPage {
  /** False when Notion stopped at its limit of 10,000 results for one query. */
  complete: boolean;
}

export interface NotionClient {
  /** One page of the data sources shared with the connection. */
  dataSources(cursor?: string | null): Promise<NotionPage>;
  /** A data source with its properties. */
  dataSource(id: string): Promise<Record<string, unknown>>;
  /** One page of a data source's pages edited at or after `from`, oldest edit first, with only the named properties. */
  pages(id: string, properties: readonly string[], from: string, cursor?: string | null): Promise<NotionQueryPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Seconds from a Retry-After header, or undefined when it doesn't read as seconds. */
function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value);
}

export function notionClient(options: NotionClientOptions): NotionClient {
  if (!/^[A-Za-z0-9_-]{20,4096}$/.test(options.token)) throw new NotionConfigError("NOTION_ACCESS_TOKEN is missing or not in the expected shape");
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = options.rateLimitRetries ?? 3;
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token}`, Accept: "application/json", "Notion-Version": NOTION_VERSION };

  async function send(method: "GET" | "POST", path: string, query: [string, string][], body: unknown, what: string): Promise<Record<string, unknown>> {
    const url = new URL(`${NOTION_API}${path}`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    const init: RequestInit = method === "GET" ? { method, headers } : { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, init);
      if (response.status === 429 && attempt < retries) {
        const wait = retryAfter(response.headers.get("retry-after"));
        await sleep(1000 * (wait !== undefined ? Math.min(Math.max(wait, 1), MAX_RETRY_AFTER_S) : 2 ** attempt));
        continue;
      }
      const reply: unknown = await response.json().catch(() => undefined);
      if (response.status === 401) throw new NotionApiError("Notion turned down the token: check NOTION_ACCESS_TOKEN, which may have been revoked", 401);
      if (response.status === 403) throw new NotionApiError(`Notion's connection isn't allowed to read ${what}: give it the Read content capability`, 403);
      if (response.status === 404) throw new NotionApiError(`Notion couldn't find ${what}, or it isn't shared with the connection`, 404);
      if (response.status !== 200) throw new NotionApiError(`Notion answered HTTP ${response.status} for ${what}`, response.status);
      if (!isObject(reply)) throw new NotionApiError(`Notion answered ${what} with a body that isn't a JSON object`, 200);
      return reply;
    }
  }

  function list(reply: Record<string, unknown>, what: string): NotionPage {
    if (!Array.isArray(reply.results)) throw new NotionApiError(`Notion answered ${what} without the results list`, 200);
    const next = reply.has_more === true ? reply.next_cursor : null;
    if (next != null && (typeof next !== "string" || !CURSOR.test(next))) throw new NotionApiError(`Notion sent a page cursor for ${what} that isn't in the expected shape`, 200);
    return { data: (reply.results as unknown[]).map((r) => (isObject(r) ? r : {})), next: (next as string | null | undefined) ?? null };
  }

  const checkCursor = (cursor: string | null | undefined, what: string) => {
    if (cursor != null && !CURSOR.test(cursor)) throw new NotionApiError(`the page cursor for ${what} isn't in the expected shape`, 0);
  };
  const id = (value: string, what: string) => {
    const out = notionId(value);
    if (!out) throw new NotionApiError(`${what} id is not a Notion id`, 0);
    return out;
  };

  return {
    async dataSources(cursor) {
      checkCursor(cursor, "data sources");
      const body = { filter: { property: "object", value: "data_source" }, page_size: NOTION_PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) };
      return list(await send("POST", "/search", [], body, "data sources"), "data sources");
    },
    async dataSource(source) {
      return send("GET", `/data_sources/${id(source, "data source")}`, [], undefined, "a data source");
    },
    async pages(source, properties, from, cursor) {
      const path = `/data_sources/${id(source, "data source")}/query`;
      checkCursor(cursor, "a data source's pages");
      if (!ISO.test(from) || Number.isNaN(Date.parse(from)) || new Date(from).toISOString() !== from) throw new NotionApiError("the edited-since time must be a UTC time", 0);
      if (properties.length === 0) throw new NotionApiError("a query must name its properties, or Notion returns every property", 0);
      if (properties.length > NOTION_MAX_PROPERTIES) throw new NotionApiError(`a query names at most ${NOTION_MAX_PROPERTIES} properties`, 0);
      const decoded = properties.map((p) => {
        const d = notionPropertyId(p);
        if (d === undefined) throw new NotionApiError("a property id isn't in the expected shape", 0);
        return d;
      });
      const body = {
        filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: from } },
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        page_size: NOTION_PAGE_SIZE,
        ...(cursor ? { start_cursor: cursor } : {}),
      };
      const reply = await send("POST", path, decoded.map((p): [string, string] => ["filter_properties", p]), body, "a data source's pages");
      const page = list(reply, "a data source's pages");
      // Keep only the properties asked for, whatever came back.
      const asked = new Set(decoded);
      const data = page.data.map((p) => {
        const props = isObject(p.properties) ? p.properties : {};
        const kept = Object.fromEntries(Object.entries(props).filter(([, v]) => isObject(v) && asked.has(notionPropertyId(v.id) ?? "")));
        return { object: p.object, id: p.id, created_time: p.created_time, last_edited_time: p.last_edited_time, in_trash: p.in_trash, properties: kept };
      });
      const status = isObject(reply.request_status) ? reply.request_status.type : undefined;
      return { data, next: page.next, complete: status !== "incomplete" };
    },
  };
}
