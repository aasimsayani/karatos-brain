import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

/**
 * A small client for the WatchBase Data Feed API (v1): reference data about
 * watch models, by brand, family and reference number. The API only gives
 * data, so read-only holds by nature; the client also sends only GETs, to
 * the three reads the connector needs, with query strings it builds itself.
 *
 * WatchBase takes its API key as the `key` parameter. So a request URL is
 * never put in an error, a log or a thrown error's cause, and any text
 * WatchBase sends back has the key, any `key=` pair and any URL masked
 * before it is quoted.
 *
 * Each watch read (`/v1/watch`) is charged in DataFeed credits, US$0.25 a
 * watch; the docs don't say the brand and watch lists are charged. They give
 * no rate limit and no error format, so a 429 or 5xx is retried with backoff
 * before the error goes to runSync, and a 401 or 403 is a key problem.
 */

export const WATCHBASE_API_BASE = "https://api.watchbase.com/v1";
/** The same User-Agent the other connectors send. */
export const WATCHBASE_USER_AGENT = WHATNOT_USER_AGENT;
export const WATCHBASE_BRANDS_PATH = "/brands";
export const WATCHBASE_WATCHES_PATH = "/watches";
export const WATCHBASE_WATCH_PATH = "/watch";

/**
 * WatchBase doesn't give the key's format; the key in its examples is 40
 * letters and digits. So 16 to 128 letters, digits, _ or - are accepted:
 * a guess to check against a real key, which keeps out spaces, `&`, `=` and
 * the like that would change the query string.
 */
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
/** A BrandID or watch id: the docs' examples are whole numbers. */
const ID = /^[1-9][0-9]{0,8}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface WatchbaseClientOptions {
  /** The datafeed account's API key. It is never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before a retry; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class WatchbaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchbaseConfigError";
  }
}

/** WatchBase answered with an error, or couldn't be reached (status 0). */
export class WatchbaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WatchbaseApiError";
  }
}

export interface WatchbaseClient {
  /** Every brand in the database, each {id, name}. */
  brands(): Promise<unknown[]>;
  /** The brand's watches, each {id, refnr, name, brand, family, updated}; only those created or changed after `since` (YYYY-MM-DD) when given. */
  watches(brandId: number, since: string | null): Promise<unknown[]>;
  /** One watch with its full specs. Each call is charged one watch entry. */
  watch(id: number): Promise<unknown>;
}

/** Whether a value is a whole-number id as WatchBase gives them. */
export const isWatchbaseId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && ID.test(String(v));

/** Whether a string names a real day as YYYY-MM-DD (so 2026-02-30 is turned down). */
export const isWatchbaseDay = (v: unknown): v is string => {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * The docs show only the XML answer: a `response` root holding the fields.
 * The JSON answer is taken to hold the same fields, with or without that root.
 */
export function watchbaseRoot(body: unknown): Record<string, unknown> | undefined {
  const b = obj(body);
  return obj(b?.response) ?? b;
}

/**
 * A list as XML turned into JSON may give it: the container as an array, or
 * as an object holding one entry or an array of entries under the item's
 * name. An empty container, or none at all, reads as no entries only when
 * `num_results` is 0. Undefined when it doesn't read.
 */
export function watchbaseList(root: Record<string, unknown>, container: string, item: string): unknown[] | undefined {
  const c = root[container];
  if (Array.isArray(c)) return c;
  const holder = obj(c);
  if (holder && Object.hasOwn(holder, item)) {
    const inner = holder[item];
    if (Array.isArray(inner)) return inner;
    if (obj(inner)) return [inner];
    return undefined;
  }
  const none = c === undefined || c === null || c === "" || (holder !== undefined && Object.keys(holder).length === 0);
  return none && (root.num_results === 0 || root.num_results === "0") ? [] : undefined;
}

export function watchbaseClient(options: WatchbaseClientOptions): WatchbaseClient {
  const key = options.apiKey?.trim() ?? "";
  if (!KEY.test(key)) throw new WatchbaseConfigError("set WATCHBASE_API_KEY to the API key of a WatchBase datafeed account: 16 to 128 letters, digits, _ or -");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  /** WatchBase's own words, with the key masked and cut short. Never the URL. */
  const quote = (said: string) => {
    const clean = said
      .split(key)
      .join("[key]")
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/\bkey\s*=\s*["']?[^&\s"']*["']?/gi, "key=[key]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return clean ? `: ${clean}` : "";
  };
  /** What an answer says went wrong: its error or message, or a short plain-text body. */
  const said = (body: unknown, text: string): string => {
    const r = watchbaseRoot(body) ?? {};
    for (const v of [r.error, r.message]) if (typeof v === "string" && v.trim()) return v;
    const nested = obj(r.error);
    if (nested && typeof nested.message === "string") return nested.message;
    return body === null && !/^\s*</.test(text) ? text : "";
  };

  async function get(path: string, what: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ ...params, format: "json", key });
    const url = `${WATCHBASE_API_BASE}${path}?${query}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        // GET only, with no body: there is nothing to write in WatchBase.
        response = await doFetch(url, { method: "GET", headers: { accept: "application/json", "user-agent": WATCHBASE_USER_AGENT } });
      } catch {
        // The fetch error can name the URL, and the URL holds the key, so it is dropped.
        throw new WatchbaseApiError(`could not reach WatchBase for the ${what}`, 0);
      }
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const text = await response.text().catch(() => "");
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (response.status === 401 || response.status === 403) {
        throw new WatchbaseConfigError(`WatchBase turned down the API key (HTTP ${response.status})${quote(said(body, text))}; WATCHBASE_API_KEY must be the API key of a WatchBase datafeed account with credits left`);
      }
      if (response.status !== 200) throw new WatchbaseApiError(`WatchBase answered HTTP ${response.status} for the ${what}${quote(said(body, text))}`, response.status);
      const root = watchbaseRoot(body);
      if (!root) throw new WatchbaseApiError(`WatchBase answered the ${what} without JSON that reads`, 200);
      // The docs give no error format; an answer that carries an error is taken as one.
      if (root.error !== undefined && root.error !== null && root.error !== "") throw new WatchbaseApiError(`WatchBase answered the ${what} with an error${quote(said(body, text))}`, 200);
      return root;
    }
  }

  const list = (root: Record<string, unknown>, container: string, item: string, what: string) => {
    const rows = watchbaseList(root, container, item);
    if (!rows) throw new WatchbaseApiError(`WatchBase answered the ${what} without a list that reads`, 200);
    return rows;
  };

  return {
    async brands() {
      return list(await get(WATCHBASE_BRANDS_PATH, "brand list", {}), "brands", "brand", "brand list");
    },
    async watches(brandId, since) {
      if (!isWatchbaseId(brandId)) throw new WatchbaseApiError("a BrandID must be a whole number WatchBase gave", 0);
      if (since !== null && !isWatchbaseDay(since)) throw new WatchbaseApiError("updated-since must be a day as YYYY-MM-DD", 0);
      const params: Record<string, string> = { "brand-id": String(brandId) };
      if (since !== null) params["updated-since"] = since;
      return list(await get(WATCHBASE_WATCHES_PATH, "watch list", params), "watches", "watch", "watch list");
    },
    async watch(id) {
      if (!isWatchbaseId(id)) throw new WatchbaseApiError("a watch id must be a whole number WatchBase gave", 0);
      const root = await get(WATCHBASE_WATCH_PATH, "watch", { id: String(id) });
      const watch = obj(root.watch);
      if (!watch) throw new WatchbaseApiError("WatchBase answered the watch without a watch that reads", 200);
      return watch;
    },
  };
}
