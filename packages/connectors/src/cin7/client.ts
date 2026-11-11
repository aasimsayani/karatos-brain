/**
 * A small client for Cin7 Core's API v2 (the API that began as DEAR
 * Inventory). Cin7 Core signs a call in by two headers, the account id in
 * `api-auth-accountid` and an API application's key in
 * `api-auth-applicationkey`, and its docs describe no way to limit what an
 * application can do: the key could also change stock and post orders. So
 * this client is what keeps KaratOS to reading. It sends only GETs of six
 * lists, to Cin7 Core's fixed address, with parameters it builds itself
 * from checked values:
 *
 * - `GET /product`, `/customer` and `/supplier`: records modified since a
 *   time (or every one), deprecated ones included;
 * - `GET /saleList` and `/purchaseList`: orders updated since a time;
 * - `GET /ref/productavailability`: stock of each product at each
 *   location, read whole each time.
 *
 * Each list pages by number, up to 1,000 a page, and answers its rows with
 * the Total that match. Cin7 Core allows 60 calls a minute for each
 * application and answers 503 past that, so the client spaces its calls a
 * second apart, and waits a 429, 500, 502, 503 or 504 out a few times
 * (honoring Retry-After) before the error goes to runSync, which keeps the
 * checkpoint.
 */

export const CIN7_API_URL = "https://inventory.dearsystems.com/ExternalApi/v2";
/** Records asked for at a time: the most Cin7 Core gives a page. */
export const CIN7_PAGE_SIZE = 1000;
/** Pages read per pass at most, so a page number never runs away. */
export const CIN7_MAX_PAGE = 1000;
/** Calls are spaced this far apart, to stay inside 60 a minute. */
export const CIN7_SPACING_MS = 1000;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** Cin7 Core's account ids and application keys are GUIDs. */
const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export type Cin7List = "products" | "customers" | "suppliers" | "sales" | "purchases" | "stock";

export interface Cin7ClientOptions {
  /** The Cin7 Core account id (CIN7_ACCOUNT_ID). */
  accountId: string;
  /** The API application's key (CIN7_APPLICATION_KEY). Sent to Cin7 Core only, and never logged or shown. */
  applicationKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before a call or a retry; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock calls are spaced by; replaced in tests. */
  clock?: () => number;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class Cin7ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Cin7ConfigError";
  }
}

export class Cin7ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "Cin7ApiError";
  }
}

export interface Cin7Page {
  rows: unknown[];
  /** How many records match, as Cin7 Core counts them. */
  total: number;
}

export interface Cin7Client {
  /** One page (from 1) of a list: changed since `since` (ISO), or every record when it is null. Stock takes no start. */
  page(list: Cin7List, since: string | null, page: number): Promise<Cin7Page>;
}

/** Each list's path, the key its rows come under, its change filter and anything else always sent. */
const LISTS = new Map<Cin7List, { path: string; rows: string; since: string | null; extra: [string, string][] }>([
  ["products", { path: "product", rows: "Products", since: "ModifiedSince", extra: [["IncludeDeprecated", "true"]] }],
  ["customers", { path: "customer", rows: "CustomerList", since: "ModifiedSince", extra: [["IncludeDeprecated", "true"]] }],
  ["suppliers", { path: "supplier", rows: "SupplierList", since: "ModifiedSince", extra: [["IncludeDeprecated", "true"]] }],
  ["sales", { path: "saleList", rows: "SaleList", since: "UpdatedSince", extra: [] }],
  ["purchases", { path: "purchaseList", rows: "PurchaseList", since: "UpdatedSince", extra: [] }],
  ["stock", { path: "ref/productavailability", rows: "ProductAvailabilityList", since: null, extra: [] }],
]);

export function cin7Client(options: Cin7ClientOptions): Cin7Client {
  const account = options.accountId?.trim() ?? "";
  const key = options.applicationKey?.trim() ?? "";
  if (!GUID.test(account)) throw new Cin7ConfigError("CIN7_ACCOUNT_ID is missing or isn't a Cin7 Core account id");
  if (!GUID.test(key)) throw new Cin7ConfigError("CIN7_APPLICATION_KEY is missing or isn't a Cin7 Core application key");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const retries = options.retries ?? 3;
  let lastCall = Number.NEGATIVE_INFINITY;

  return {
    async page(list, since, page) {
      const spec = LISTS.get(list);
      if (!spec) throw new Cin7ApiError(`${String(list).slice(0, 20)} is not a list KaratOS reads`, 0);
      if (!Number.isSafeInteger(page) || page < 1 || page > CIN7_MAX_PAGE) throw new Cin7ApiError(`a ${list} page must be 1 to ${CIN7_MAX_PAGE}`, 0);
      if (since !== null && (spec.since === null || Number.isNaN(Date.parse(since)))) throw new Cin7ApiError(`a ${list} start must be a time, and stock takes none`, 0);
      const url = new URL(`${CIN7_API_URL}/${spec.path}`);
      url.searchParams.set("Page", String(page));
      url.searchParams.set("Limit", String(CIN7_PAGE_SIZE));
      if (since !== null) url.searchParams.set(spec.since!, new Date(since).toISOString());
      for (const [name, value] of spec.extra) url.searchParams.set(name, value);
      for (let attempt = 0; ; attempt++) {
        const wait = lastCall + CIN7_SPACING_MS - clock();
        if (wait > 0) await sleep(wait);
        lastCall = clock();
        const response = await doFetch(url.toString(), { method: "GET", headers: { "api-auth-accountid": account, "api-auth-applicationkey": key, accept: "application/json" } });
        const { status } = response;
        if (RETRIED.has(status) && attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 5000 * 2 ** attempt);
          continue;
        }
        if (status === 401 || status === 403) throw new Cin7ConfigError("Cin7 Core turned down CIN7_ACCOUNT_ID and CIN7_APPLICATION_KEY: check both, and that the API application is still there");
        if (status !== 200) throw new Cin7ApiError(`Cin7 Core answered HTTP ${status} for the ${list}`, status);
        const body = ((await response.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
        if (!Array.isArray(body[spec.rows]) || !Number.isSafeInteger(body.Total)) throw new Cin7ApiError(`Cin7 Core answered the ${list} without the list and its Total`, 200);
        return { rows: body[spec.rows] as unknown[], total: body.Total as number };
      }
    },
  };
}
