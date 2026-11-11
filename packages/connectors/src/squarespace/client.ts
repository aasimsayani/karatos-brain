/**
 * A small client for a Squarespace site's Commerce APIs, read-only two ways
 * over: the API key is made with Read Only permission for Orders, Inventory
 * and Products (Squarespace lets each be read-only), and the only requests
 * the client sends are GETs of those three lists, with parameters it builds
 * itself.
 *
 * Every request carries the key as a Bearer token and a User-Agent naming
 * KaratOS, which Squarespace requires. Squarespace's own error text is never
 * put in an error here, only the HTTP status. Squarespace allows 300
 * requests a minute and answers 429 for a minute's cool-down past that, so
 * a 429 waits out Retry-After (or a minute) and a 5xx waits longer each
 * time, a few times, before the error goes to runSync, which keeps the
 * checkpoint.
 */

export const SQUARESPACE_BASE_URL = "https://api.squarespace.com";
export const SQUARESPACE_USER_AGENT = "KaratOS Brain (read-only sync)";

/** The three reads, each with its path and the field that holds its records. */
export const SQUARESPACE_LISTS = {
  products: { path: "/v2/commerce/products", field: "products", permission: "Products" },
  inventory: { path: "/1.0/commerce/inventory", field: "inventory", permission: "Inventory" },
  orders: { path: "/1.0/commerce/orders", field: "result", permission: "Orders" },
} as const;
export type SquarespaceList = keyof typeof SQUARESPACE_LISTS;

const MAX_WAIT_S = 60;
const RATE_LIMIT_WAIT_MS = 60_000;
const KEY = /^[\x21-\x7e]{16,512}$/;
const CURSOR = /^[A-Za-z0-9_=+/.:-]{1,2048}$/;
/** A UTC time as toISOString writes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface SquarespacePageQuery {
  /** The previous page's nextPageCursor, or null for the first page. */
  cursor: string | null;
  /** Orders only: modified after this UTC time... */
  from?: string;
  /** ...and up to this one. */
  to?: string;
}

export interface SquarespacePage {
  records: unknown[];
  /** The cursor of the next page, or null after the last. */
  next: string | null;
}

export interface SquarespaceClientOptions {
  /** An API key with Read Only permission for Orders, Inventory and Products (SQUARESPACE_API_KEY). */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class SquarespaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquarespaceConfigError";
  }
}

export class SquarespaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SquarespaceApiError";
  }
}

export interface SquarespaceClient {
  list(list: SquarespaceList, query: SquarespacePageQuery): Promise<SquarespacePage>;
}

/**
 * The query string for one page, or a config error before anything is sent.
 * A cursor goes alone, as Squarespace requires. The first page of orders
 * names its window; products and stock are read whole.
 */
export function squarespaceListParams(list: SquarespaceList, query: SquarespacePageQuery): URLSearchParams {
  if (!Object.hasOwn(SQUARESPACE_LISTS, list)) throw new SquarespaceConfigError("Squarespace reads only products, inventory and orders");
  if (query.cursor !== null) {
    if (!CURSOR.test(query.cursor)) throw new SquarespaceConfigError("a page cursor must be one Squarespace gave");
    return new URLSearchParams({ cursor: query.cursor });
  }
  if (list !== "orders") return new URLSearchParams();
  const { from = "", to = "" } = query;
  if (!TIME.test(from) || !TIME.test(to) || from > to) throw new SquarespaceConfigError("orders are listed between two UTC times");
  return new URLSearchParams({ modifiedAfter: from, modifiedBefore: to });
}

export function squarespaceClient(options: SquarespaceClientOptions): SquarespaceClient {
  const key = options.apiKey?.trim() ?? "";
  if (!KEY.test(key)) throw new SquarespaceConfigError("SQUARESPACE_API_KEY is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    async list(list, query) {
      const spec = SQUARESPACE_LISTS[list];
      const params = squarespaceListParams(list, query);
      const url = `${SQUARESPACE_BASE_URL}${spec.path}${params.size ? `?${params}` : ""}`;
      for (let attempt = 0; ; attempt++) {
        // GET only, with the key in its header and never in the URL.
        const response = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${key}`, "user-agent": SQUARESPACE_USER_AGENT, accept: "application/json" } });
        const { status } = response;
        if ((status === 429 || status >= 500) && attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(status === 429 ? (after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : RATE_LIMIT_WAIT_MS) : 1000 * 2 ** attempt);
          continue;
        }
        if (status === 401) throw new SquarespaceConfigError("Squarespace turned down SQUARESPACE_API_KEY (HTTP 401); make a new key under Settings, Developer API Keys");
        if (status === 402) throw new SquarespaceConfigError("Squarespace says the site's plan has expired (HTTP 402)");
        if (status === 403) throw new SquarespaceConfigError(`SQUARESPACE_API_KEY lacks Read Only permission for ${spec.permission} (HTTP 403)`);
        if (status === 429) throw new SquarespaceApiError(`Squarespace kept rate-limiting the sync (HTTP 429) on ${list}; the next sync resumes from the checkpoint`, status);
        if (status !== 200) throw new SquarespaceApiError(`Squarespace answered HTTP ${status} for ${list}`, status);
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        const records = body?.[spec.field];
        if (!Array.isArray(records)) throw new SquarespaceApiError(`Squarespace answered without a list of ${list}`, status);
        const pagination = (body!.pagination ?? {}) as Record<string, unknown>;
        if (pagination.hasNextPage !== true) return { records, next: null };
        const next = pagination.nextPageCursor;
        // A page that says more follow without a cursor that reads would loop, so it is an error.
        if (typeof next !== "string" || !CURSOR.test(next)) throw new SquarespaceApiError(`Squarespace said more ${list} follow without a cursor that reads`, status);
        return { records, next };
      }
    },
  };
}
