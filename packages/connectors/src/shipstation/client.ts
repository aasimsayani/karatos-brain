/**
 * A small client for ShipStation's API v2. ShipStation gives an account one
 * kind of API key, sent in the `API-Key` header, and the key has the
 * account's full access: it could also buy labels, which spend the
 * account's postage balance, and void them. ShipStation has no read-only
 * key. So this client is what keeps KaratOS to reading: it sends only GETs
 * of two lists, to ShipStation's fixed address, with parameters it builds
 * itself from checked values:
 *
 * - `GET /v2/shipments`: shipments changed since a time, oldest change
 *   first;
 * - `GET /v2/labels`: labels created since a time, oldest first, with their
 *   tracking status.
 *
 * Both page by number, 100 at a time. A 429 and 500, 502, 503 and 504 are
 * waited out a few times, honoring Retry-After (ShipStation allows 200
 * requests a minute), before the error goes to runSync, which keeps the
 * checkpoint.
 */

export const SHIPSTATION_API_URL = "https://api.shipstation.com/v2";
/** Records asked for at a time. */
export const SHIPSTATION_PAGE_SIZE = 100;
/** Pages read per pass at most, so a page number never runs away. */
export const SHIPSTATION_MAX_PAGE = 2_000;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const API_KEY = /^[A-Za-z0-9_+/=-]{20,128}$/;

export type ShipStationList = "shipments" | "labels";

export interface ShipStationClientOptions {
  /** The account's API key (SHIPSTATION_API_KEY). Sent to ShipStation only, and never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class ShipStationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShipStationConfigError";
  }
}

export class ShipStationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ShipStationApiError";
  }
}

export interface ShipStationPage {
  rows: unknown[];
  /** How many pages the list has, as ShipStation counts them. */
  pages: number;
}

export interface ShipStationClient {
  /** One page (from 1) of a list, oldest first: shipments changed, or labels created, at or after `since` (ISO). */
  page(list: ShipStationList, since: string, page: number): Promise<ShipStationPage>;
}

/** Each list's filter and sort: shipments by their last change, labels by when they were made. */
const QUERY: Record<ShipStationList, { start: string; sort: string }> = {
  shipments: { start: "modified_at_start", sort: "modified_at" },
  labels: { start: "created_at_start", sort: "created_at" },
};

export function shipStationClient(options: ShipStationClientOptions): ShipStationClient {
  const key = options.apiKey?.trim() ?? "";
  if (!API_KEY.test(key)) throw new ShipStationConfigError("SHIPSTATION_API_KEY is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    async page(list, since, page) {
      if (!Number.isSafeInteger(page) || page < 1 || page > SHIPSTATION_MAX_PAGE) throw new ShipStationApiError(`a ${list} page must be 1 to ${SHIPSTATION_MAX_PAGE}`, 0);
      if (Number.isNaN(Date.parse(since))) throw new ShipStationApiError(`a ${list} start must be a time`, 0);
      const url = new URL(`${SHIPSTATION_API_URL}/${list}`);
      url.searchParams.set(QUERY[list].start, since);
      url.searchParams.set("sort_by", QUERY[list].sort);
      url.searchParams.set("sort_dir", "asc");
      url.searchParams.set("page_size", String(SHIPSTATION_PAGE_SIZE));
      url.searchParams.set("page", String(page));
      for (let attempt = 0; ; attempt++) {
        const response = await doFetch(url.toString(), { method: "GET", headers: { "API-Key": key, accept: "application/json" } });
        const { status } = response;
        if (RETRIED.has(status) && attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
          continue;
        }
        if (status === 401) throw new ShipStationConfigError("ShipStation turned down SHIPSTATION_API_KEY: check it, and that the account's plan includes the API");
        if (status === 403) throw new ShipStationConfigError(`SHIPSTATION_API_KEY can't read ${list}: check that the account's plan includes it`);
        if (status !== 200) throw new ShipStationApiError(`ShipStation answered HTTP ${status} for the ${list}`, status);
        const body = ((await response.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
        if (!Array.isArray(body[list]) || !Number.isSafeInteger(body.pages)) throw new ShipStationApiError(`ShipStation answered the ${list} without the list and its page count`, 200);
        // A page ShipStation says is another one would read the same records over and over.
        if (body.page !== page) throw new ShipStationApiError(`ShipStation answered page ${String(body.page).slice(0, 12)} of the ${list} when asked for page ${page}`, 200);
        return { rows: body[list] as unknown[], pages: body.pages as number };
      }
    },
  };
}
