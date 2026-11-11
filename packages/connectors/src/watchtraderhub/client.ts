/**
 * A small client for WatchTraderHub's Custom Integration API, v1. Requests
 * carry a dealer's API key as a bearer token: `wth_` and 32 base62
 * characters, made under Custom Integration, Settings, in the dealer
 * dashboard on the Business plan. A key belongs to one integration and has no
 * scopes: the same key can report and cancel orders and upsert customers. So
 * read-only is enforced here, in code: the client sends GET requests to four
 * endpoints, with query strings it builds itself, and has no way to send
 * anything else.
 *
 * Errors come back as {error: {type, code, message, request_id}}. The API
 * allows 600 requests a minute per integration and answers 429
 * too_many_requests with Retry-After past that; a 429 or 5xx is retried with
 * backoff before the error goes to runSync.
 */

import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

export const WATCHTRADERHUB_API_BASE = "https://www.watchtraderhub.com/api/v1";
/** Rows asked for per page: the most a WatchTraderHub list returns. */
export const WATCHTRADERHUB_PAGE_SIZE = 250;
/** Every request carries the same User-Agent as the other connectors. */
export const WATCHTRADERHUB_USER_AGENT = WHATNOT_USER_AGENT;

/** The key format the authentication page gives: wth_ and 32 base62 characters. */
const KEY = /^wth_[A-Za-z0-9]{32}$/;
/** A key-shaped run in a message, hidden before the message is kept. */
const KEY_RUN = /wth_[A-Za-z0-9]{32}/g;
/** The docs call cursors opaque and give no length; a cursor is taken as 1 to 2048 visible ASCII characters. */
const CURSOR = /^[!-~]{1,2048}$/;
/** An updated_after the connector made: an ISO time in UTC with milliseconds. */
const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CODE = /^[a-z_]{1,64}$/;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface WatchTraderHubClientOptions {
  /** The dealer's API key. It is never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class WatchTraderHubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchTraderHubConfigError";
  }
}

/** WatchTraderHub answered with an error. `code` is its error code, such as too_many_requests, when it gives one that reads. */
export class WatchTraderHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WatchTraderHubApiError";
  }
}

/** One page of a list: its rows and the cursor for the next page, null after the last. */
export interface WatchTraderHubPage {
  data: unknown[];
  nextCursor: string | null;
}

export interface WatchTraderHubListRequest {
  /** The next_cursor of the previous page, or null for the first. */
  after: string | null;
  /** Only rows changed after this time, or null for every row. */
  updatedAfter: string | null;
}

export interface WatchTraderHubClient {
  /** The integration the key belongs to: GET /me. */
  me(): Promise<Record<string, unknown>>;
  listings(request: WatchTraderHubListRequest): Promise<WatchTraderHubPage>;
  parts(request: WatchTraderHubListRequest): Promise<WatchTraderHubPage>;
  orders(request: WatchTraderHubListRequest): Promise<WatchTraderHubPage>;
}

export const isWatchTraderHubCursor = (v: unknown): v is string => typeof v === "string" && CURSOR.test(v);
export const isWatchTraderHubSince = (v: unknown): v is string => typeof v === "string" && SINCE.test(v) && new Date(v).toISOString() === v;

/** The error's code and message, cut short, with anything shaped like a key hidden. */
function detail(body: unknown): { code: string | undefined; text: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown };
  const e = (typeof b.error === "object" && b.error !== null ? b.error : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" && CODE.test(e.code) ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message.replace(KEY_RUN, "wth_...").slice(0, 200) : "";
  return { code, text: `${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}` };
}

export function watchTraderHubClient(options: WatchTraderHubClientOptions): WatchTraderHubClient {
  const key = options.apiKey?.trim() ?? "";
  if (!KEY.test(key)) throw new WatchTraderHubConfigError("set WATCHTRADERHUB_API_KEY to a WatchTraderHub API key, which is wth_ and 32 letters and digits");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const authorization = `Bearer ${key}`;

  async function get(path: string, what: string, query: URLSearchParams | null): Promise<unknown> {
    const url = `${WATCHTRADERHUB_API_BASE}${path}${query ? `?${query}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with the key in the Authorization header and never in the URL.
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization, "user-agent": WATCHTRADERHUB_USER_AGENT } });
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      const { code, text } = detail(body);
      // The docs call auth_lookup_failed transient: it is left for runSync to retry, not blamed on the key.
      if ((response.status === 401 && code !== "auth_lookup_failed") || response.status === 403) {
        throw new WatchTraderHubConfigError(
          `WatchTraderHub turned down the API key (HTTP ${response.status})${text}; WATCHTRADERHUB_API_KEY must be the current key of an enabled custom integration on the dealer's Business plan`,
        );
      }
      if (response.status !== 200) throw new WatchTraderHubApiError(`WatchTraderHub answered HTTP ${response.status} for the ${what}${text}`, response.status, code);
      return body;
    }
  }

  async function list(path: string, what: string, request: WatchTraderHubListRequest): Promise<WatchTraderHubPage> {
    const { after, updatedAfter } = request;
    if (after !== null && !isWatchTraderHubCursor(after)) throw new WatchTraderHubApiError(`a cursor for the ${what} must be 1 to 2048 visible characters`, 0);
    if (updatedAfter !== null && !isWatchTraderHubSince(updatedAfter)) throw new WatchTraderHubApiError(`updated_after for the ${what} must be an ISO time in UTC`, 0);
    const query = new URLSearchParams({ limit: String(WATCHTRADERHUB_PAGE_SIZE) });
    if (after !== null) query.set("after", after);
    if (updatedAfter !== null) query.set("updated_after", updatedAfter);
    const body = (await get(path, what, query)) as { object?: unknown; data?: unknown; has_more?: unknown; next_cursor?: unknown } | null;
    const data = body?.data;
    const next = body?.next_cursor ?? null;
    const reads =
      body?.object === "list" &&
      Array.isArray(data) &&
      typeof body.has_more === "boolean" &&
      (next === null || isWatchTraderHubCursor(next)) &&
      // has_more and next_cursor say the same thing, as the pagination page says.
      body.has_more === (next !== null);
    if (!reads) throw new WatchTraderHubApiError(`WatchTraderHub answered the ${what} without a page that reads`, 200);
    if (next !== null && next === after) throw new WatchTraderHubApiError(`WatchTraderHub answered the ${what} with the same cursor again`, 200);
    return { data: data as unknown[], nextCursor: next as string | null };
  }

  return {
    me: async () => {
      const body = (await get("/me", "integration", null)) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object" || Array.isArray(body) || body.object !== "integration") throw new WatchTraderHubApiError("WatchTraderHub answered the integration without one that reads", 200);
      return body;
    },
    listings: (request) => list("/listings", "listings", request),
    parts: (request) => list("/parts", "parts", request),
    orders: (request) => list("/orders", "orders", request),
  };
}
