import { checkDocMock, type DocMock, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * Notion's API (version 2026-03-11) endpoints for searching data sources,
 * reading one data source's schema and querying its pages, built from the
 * API reference. Data is synthetic. Like Notion, the mock returns every
 * property of a page when the query names none, and only the named ones
 * when it does, so a test can show the connector never asks for a title or
 * text property.
 */
const API = "https://api.notion.com/v1";
const DOCS = "https://developers.notion.com/reference";
const VERSION = "2026-03-11";

export interface NotionMockProperty {
  id: string;
  name: string;
  type: string;
  [config: string]: unknown;
}

export interface NotionMockSource {
  id: string;
  title: string;
  databaseId: string;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  /** The schema, by property name, as Notion keys it. */
  properties: Record<string, NotionMockProperty>;
}

export interface NotionMockPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  /** Property values by property name: each `{ id, type, [type]: value }`. */
  properties: Record<string, Record<string, unknown>>;
}

export interface NotionMockData {
  /** Data sources shared with the connection. */
  dataSources: NotionMockSource[];
  /** Pages by data source id. */
  pages: Record<string, NotionMockPage[]>;
  /** The token the mock accepts. Any bearer token is accepted when absent. */
  token?: string;
  /** Rows per page the mock caps at, to exercise paging. Defaults to 100. */
  pageCap?: number;
  /** The most results one query returns, as Notion stops at 10,000. */
  resultLimit?: number;
  /** How many of the next requests answer 429, each with Retry-After `retryAfter` seconds (default 1). */
  rateLimited?: number;
  retryAfter?: string;
}

const error = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { object: "error", status, code, message, request_id: "test-request" } });
const QUERY_KEYS = new Set(["filter", "sorts", "start_cursor", "page_size", "is_archived", "result_type"]);
const SEARCH_KEYS = new Set(["query", "filter", "sort", "start_cursor", "page_size"]);

export function notionDocMock(data: NotionMockData): DocMock {
  const denied = (request: { headers: Headers }): DocMockResponse | null => {
    if (data.token !== undefined && request.headers.get("authorization") !== `Bearer ${data.token}`) return error(401, "unauthorized", "API token is invalid.");
    if (request.headers.get("notion-version") !== VERSION) return error(400, "missing_version", "Notion-Version header failed validation.");
    if (data.rateLimited) {
      data.rateLimited--;
      return { ...error(429, "rate_limited", "You have been rated limited. Please try again in a few minutes."), headers: { "Retry-After": data.retryAfter ?? "1" } };
    }
    return null;
  };
  const source = (id: string | undefined) => data.dataSources.find((s) => s.id === id);
  const parse = (body: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(body);
      return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  /** Cursors look like Notion's: an opaque string the mock reads back. */
  const paged = <T>(rows: T[], body: Record<string, unknown>, extra: Record<string, unknown> = {}): DocMockResponse => {
    const size = body.page_size ?? 100;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 100) return error(400, "validation_error", "body.page_size should be a number between 1 and 100.");
    const raw = body.start_cursor;
    const start = raw === undefined ? 0 : Number(/^cursor-(\d+)$/.exec(String(raw))?.[1] ?? NaN);
    if (!Number.isInteger(start)) return error(400, "validation_error", "body.start_cursor should be a valid cursor.");
    const end = start + Math.min(size, data.pageCap ?? 100);
    const more = end < rows.length;
    return { status: 200, body: { object: "list", results: rows.slice(start, end), next_cursor: more ? `cursor-${end}` : null, has_more: more, type: "page_or_data_source", page_or_data_source: {}, ...extra } };
  };
  const full = (s: NotionMockSource) => ({
    object: "data_source",
    id: s.id,
    title: [{ type: "text", text: { content: s.title, link: null }, plain_text: s.title, href: null }],
    description: [],
    parent: { type: "database_id", database_id: s.databaseId },
    database_parent: { type: "page_id", page_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    is_inline: false,
    in_trash: s.in_trash ?? false,
    created_time: s.created_time,
    last_edited_time: s.last_edited_time,
    created_by: { object: "user", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    last_edited_by: { object: "user", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    properties: s.properties,
    icon: null,
    cover: null,
    url: `https://www.notion.so/${s.id.replace(/-/g, "")}`,
    public_url: null,
  });
  return checkDocMock({
    integration: "notion",
    baseUrl: API,
    source: { url: `${DOCS}/intro`, title: "Notion API reference", retrievedOn: "2026-11-07", version: VERSION },
    auth: "bearer",
    assumptions: [
      "Search with the data_source filter returns full data source objects with their properties",
      "filter_properties takes the decoded property id, and properties not named are left out of each page",
      "A query sorted by last_edited_time ascending keeps that order across its pages",
      "A query that reaches the result limit ends with has_more false and request_status incomplete",
      "A data source that isn't shared answers 404 object_not_found",
      "A 429 carries Retry-After as whole seconds",
    ],
    routes: [
      {
        method: "POST",
        path: "/search",
        documentedAt: `${DOCS}/post-search`,
        respond(request) {
          const no = denied(request);
          if (no) return no;
          const body = parse(request.body);
          if (!body || Object.keys(body).some((k) => !SEARCH_KEYS.has(k))) return error(400, "validation_error", "body failed validation.");
          const filter = body.filter as { property?: unknown; value?: unknown } | undefined;
          const rows = filter?.property === "object" && filter.value === "data_source" ? data.dataSources.map(full) : [];
          return paged(rows, body);
        },
      },
      {
        method: "GET",
        path: "/data_sources/{data_source_id}",
        documentedAt: `${DOCS}/retrieve-a-data-source`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          const s = source(params.data_source_id);
          if (!s) return error(404, "object_not_found", `Could not find data_source with ID: ${params.data_source_id}. Make sure the relevant pages and databases are shared with your integration.`);
          return { status: 200, body: full(s) };
        },
      },
      {
        method: "POST",
        path: "/data_sources/{data_source_id}/query",
        documentedAt: `${DOCS}/query-a-data-source`,
        respond(request, params) {
          const no = denied(request);
          if (no) return no;
          const s = source(params.data_source_id);
          if (!s) return error(404, "object_not_found", `Could not find data_source with ID: ${params.data_source_id}.`);
          const body = parse(request.body);
          if (!body || Object.keys(body).some((k) => !QUERY_KEYS.has(k))) return error(400, "validation_error", "body failed validation.");
          let rows = [...(data.pages[s.id] ?? [])];
          const filter = body.filter as { timestamp?: unknown; last_edited_time?: { on_or_after?: unknown } } | undefined;
          if (filter !== undefined) {
            const after = filter.timestamp === "last_edited_time" ? filter.last_edited_time?.on_or_after : undefined;
            if (typeof after !== "string" || Number.isNaN(Date.parse(after))) return error(400, "validation_error", "body.filter failed validation.");
            rows = rows.filter((p) => Date.parse(p.last_edited_time) >= Date.parse(after));
          }
          const sorts = body.sorts as { timestamp?: unknown; direction?: unknown }[] | undefined;
          if (sorts?.[0]?.timestamp === "last_edited_time") rows.sort((a, b) => (Date.parse(a.last_edited_time) - Date.parse(b.last_edited_time)) * (sorts[0]!.direction === "descending" ? -1 : 1));
          const limit = data.resultLimit ?? 10_000;
          const incomplete = rows.length > limit;
          rows = rows.slice(0, limit);
          const named = request.url.searchParams.getAll("filter_properties");
          const shown = rows.map((p) => ({
            object: "page",
            id: p.id,
            created_time: p.created_time,
            last_edited_time: p.last_edited_time,
            in_trash: false,
            is_archived: false,
            parent: { type: "data_source_id", data_source_id: s.id, database_id: s.databaseId },
            url: p.url,
            public_url: null,
            // No properties named means every property, as Notion does.
            properties: Object.fromEntries(Object.entries(p.properties).filter(([name, v]) => named.length === 0 || named.includes(name) || named.includes(decodeURIComponent(String(v.id))))),
          }));
          return paged(shown, body, { request_status: incomplete ? { type: "incomplete", incomplete_reason: "query_result_limit_reached" } : { type: "complete" } });
        },
      },
    ],
  });
}

export default {
  integration: "notion",
  covers: "Notion's search, retrieve data source and query data source endpoints (API version 2026-03-11)",
  watchPages: [`${DOCS}/intro`, `${DOCS}/post-search`, `${DOCS}/retrieve-a-data-source`, `${DOCS}/query-a-data-source`],
  docMocks: () => [notionDocMock({ dataSources: [], pages: {} })],
} satisfies DocMockModule;
