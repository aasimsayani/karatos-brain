/**
 * A small client for the BigCommerce REST Management API, signed in with a
 * store-level API account (`X-Auth-Token`) on
 * `https://api.bigcommerce.com/stores/{store_hash}/`.
 *
 * Read-only. BigCommerce documents no way to ask which OAuth scopes a token
 * holds (scopes are fixed when the API account is created, and no store,
 * token or introspection endpoint reports them), so the connector can't
 * check them at run time. The guard is here instead: the client sends GET
 * requests only, to a fixed list of paths, each with its own query
 * parameters, and anything else is stopped before a request is made. Create
 * the API account with read-only scopes as well, so the token couldn't
 * change anything even if this code were bypassed.
 *
 * Before its first read the client asks for the store's information
 * (`GET /v2/store`) and stops unless the store hash it reports is the one
 * configured, so a token for another store is caught at once.
 *
 * Rate limits: every response carries `X-Rate-Limit-Requests-Left` and
 * `X-Rate-Limit-Time-Reset-Ms`. When no requests are left the client waits
 * out the reset before the next one, and on 429 it waits the reset (or backs
 * off when the header is missing), then hands the error to runSync, which
 * resumes from the checkpoint.
 */

export const BIGCOMMERCE_API_HOST = "https://api.bigcommerce.com";

/** BigCommerce store hashes: short lower-case letters and digits. */
const STORE_HASH = /^[a-z0-9]{6,16}$/;
/** Path IDs (orders, price lists): positive whole numbers. */
const PATH_ID = /^[1-9]\d{0,11}$/;

/** The only paths the client reads, each with the query parameters it may carry. Every one is a GET. */
export const BIGCOMMERCE_ROUTES = {
  store: { method: "GET", path: "/v2/store", params: [] },
  orders: { method: "GET", path: "/v2/orders", params: ["min_date_modified", "sort", "page", "limit"] },
  orderProducts: { method: "GET", path: "/v2/orders/{order_id}/products", params: ["page", "limit"] },
  orderRefunds: { method: "GET", path: "/v3/orders/{order_id}/payment_actions/refunds", params: [] },
  products: { method: "GET", path: "/v3/catalog/products", params: ["date_modified:min", "sort", "direction", "include", "page", "limit"] },
  inventoryItems: { method: "GET", path: "/v3/inventory/items", params: ["page", "limit"] },
  customers: { method: "GET", path: "/v3/customers", params: ["date_modified:min", "sort", "page", "limit"] },
  priceLists: { method: "GET", path: "/v3/pricelists", params: ["page", "limit"] },
  priceListRecords: { method: "GET", path: "/v3/pricelists/{price_list_id}/records", params: ["date_modified:min", "include", "page", "limit"] },
} as const satisfies Record<string, { method: "GET"; path: string; params: readonly string[] }>;
export type BigCommerceRoute = keyof typeof BIGCOMMERCE_ROUTES;

/** The read-only scopes to give the API account, as the control panel names them and as BigCommerce's docs spell them. */
export const BIGCOMMERCE_READ_SCOPES = [
  "store_v2_orders_read_only",
  "store_v2_products_read_only",
  "store_v2_customers_read_only",
  "store_v2_information_read_only",
  "store_inventory_read_only",
] as const;

export interface BigCommerceClientOptions {
  /** The store hash from the API path, e.g. abc123def4. */
  storeHash: string;
  /** The store-level API account's access token. */
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits for the rate-limit window to reset; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class BigCommerceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BigCommerceConfigError";
  }
}

/** BigCommerce answered with an error. */
export class BigCommerceApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BigCommerceApiError";
    this.status = status;
  }
}

export interface BigCommerceReadOptions {
  /** Values for the path's `{name}` parts. */
  path?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
}

export interface BigCommerceClient {
  readonly baseUrl: string;
  /** Reads one allowlisted path. A v2 list answered 204 (no records) comes back as an empty array. */
  read(route: BigCommerceRoute, options?: BigCommerceReadOptions): Promise<unknown>;
}

const MAX_WAIT_MS = 60_000;
const BACKOFF_MS = 1000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

/** BigCommerce's error text, cut short: v3 sends `title`, v2 a list of `{ message }`. Errors describe the request, never the token. */
function errorText(body: unknown): string | undefined {
  if (Array.isArray(body)) return clean((body[0] as { message?: unknown } | undefined)?.message, 200);
  const b = body as { title?: unknown; message?: unknown } | null;
  return clean(b?.title, 200) ?? clean(b?.message, 200);
}

/** Milliseconds from a rate-limit header, capped at a minute. Undefined when missing or unreadable. */
function headerMs(value: string | null): number | undefined {
  if (value === null || value.length > 12 || !/^\d+$/.test(value)) return undefined;
  return Math.min(Number(value), MAX_WAIT_MS);
}

export function bigCommerceClient(options: BigCommerceClientOptions): BigCommerceClient {
  const storeHash = options.storeHash?.trim() ?? "";
  if (!STORE_HASH.test(storeHash)) throw new BigCommerceConfigError("BIGCOMMERCE_STORE_HASH must be the store hash from the API path: 6 to 16 lower-case letters and digits");
  const token = options.accessToken?.trim() ?? "";
  if (!token) throw new BigCommerceConfigError("set BIGCOMMERCE_ACCESS_TOKEN, the store-level API account's access token");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const baseUrl = `${BIGCOMMERCE_API_HOST}/stores/${storeHash}`;
  /** Set when the last response said no requests were left: wait this long before the next one. */
  let waitBeforeNext = 0;
  let checked: Promise<void> | null = null;

  async function send(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (waitBeforeNext > 0) {
        const wait = waitBeforeNext;
        waitBeforeNext = 0;
        await sleep(wait);
      }
      // GET only: no method, body or other header is ever sent.
      const response = await doFetch(url, { method: "GET", headers: { "x-auth-token": token, accept: "application/json" } });
      const reset = headerMs(response.headers.get("x-rate-limit-time-reset-ms"));
      if (response.status !== 429) {
        if (response.headers.get("x-rate-limit-requests-left") === "0") waitBeforeNext = reset ?? BACKOFF_MS;
        return response;
      }
      if (attempt >= retries) throw new BigCommerceApiError("BigCommerce kept rate-limiting the sync; the next run resumes from the checkpoint", 429);
      await sleep(reset ?? BACKOFF_MS * 2 ** attempt);
    }
  }

  async function get(url: string): Promise<unknown> {
    const response = await send(url);
    if (response.status === 204) return [];
    if (!response.ok) {
      const text = errorText(await response.json().catch(() => null));
      const hint = response.status === 401 || response.status === 403 ? "; check the API account's token and its read-only scopes" : "";
      throw new BigCommerceApiError(`BigCommerce answered HTTP ${response.status}${text ? ` (${text})` : ""}${hint}`, response.status);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (body === undefined || body === null || typeof body !== "object") throw new BigCommerceApiError("BigCommerce did not answer with JSON", response.status);
    return body;
  }

  /** Once per client: the token must belong to the configured store. */
  function checkStore(): Promise<void> {
    checked ??= (async () => {
      const body = (await get(`${baseUrl}${BIGCOMMERCE_ROUTES.store.path}`)) as { id?: unknown };
      if (body?.id !== storeHash) throw new BigCommerceConfigError("the BigCommerce token belongs to a different store than BIGCOMMERCE_STORE_HASH");
    })().catch((error: unknown) => {
      checked = null;
      throw error;
    });
    return checked;
  }

  return {
    baseUrl,
    async read(route, readOptions = {}) {
      const spec = Object.hasOwn(BIGCOMMERCE_ROUTES, route) ? BIGCOMMERCE_ROUTES[route] : undefined;
      if (!spec || spec.method !== "GET") throw new BigCommerceConfigError("the BigCommerce connector only reads its listed paths");
      const pathValues = readOptions.path ?? {};
      const names = [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      const extra = Object.keys(pathValues).filter((k) => !names.includes(k));
      if (extra.length) throw new BigCommerceConfigError(`the BigCommerce connector doesn't fill ${extra.slice(0, 3).join(", ")} in ${spec.path}`);
      let path: string = spec.path;
      for (const name of names) {
        const value = pathValues[name];
        const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
        if (!PATH_ID.test(text)) throw new BigCommerceConfigError(`${name} must be a BigCommerce ID`);
        path = path.replace(`{${name}}`, text);
      }
      const allowed: readonly string[] = spec.params;
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(readOptions.query ?? {})) {
        if (v === undefined) continue;
        if (!allowed.includes(k)) throw new BigCommerceConfigError(`the BigCommerce connector doesn't send ${k} to ${spec.path}`);
        if (typeof v !== "string" && typeof v !== "number") throw new BigCommerceConfigError(`${k} must be a plain value`);
        query.set(k, String(v));
      }
      if (route !== "store") await checkStore();
      const qs = query.toString();
      return get(`${baseUrl}${path}${qs ? `?${qs}` : ""}`);
    },
  };
}
