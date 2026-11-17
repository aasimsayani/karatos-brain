/**
 * A small client for Katana's REST API (v1), read-only. Katana gives each
 * account API keys from Settings > API, and a key can create and delete
 * records as well as read them: Katana documents no way to limit one. So
 * this client is what keeps KaratOS to reading. It sends only GET requests,
 * only to the manufacturing orders and inventory lists, with query values
 * it builds itself from checked ones.
 *
 * Katana's own error text is never put in an error here, only the HTTP
 * status. A 429 and 500, 502, 503 and 504 are waited out a few times,
 * honoring Retry-After, before the error goes to runSync, which keeps the
 * checkpoint. Katana allows 60 requests a minute.
 */

export const KATANA_API_URL = "https://api.katanamrp.com/v1";
/** The most records Katana returns on a page. */
export const KATANA_PAGE_SIZE = 250;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const API_KEY = /^[A-Za-z0-9._-]{20,200}$/;
/** An ISO 8601 UTC time, as this client sends dates. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface KatanaClientOptions {
  /** Sent to Katana only, and never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class KatanaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KatanaConfigError";
  }
}

export class KatanaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KatanaApiError";
  }
}

/** Which manufacturing orders a page lists: those created, or those changed, since a time. */
export interface KatanaOrderQuery {
  field: "created_at_min" | "updated_at_min";
  since: string;
}

export interface KatanaPage {
  rows: unknown[];
  /** Whether a page follows this one. */
  more: boolean;
}

export interface KatanaClient {
  /** One page of manufacturing orders, deleted ones included. */
  manufacturingOrders(query: KatanaOrderQuery, page: number): Promise<KatanaPage>;
  /** One page of stock by item and location, each with its item. */
  inventory(page: number): Promise<KatanaPage>;
}

/** Katana's X-Pagination header's total_pages, or undefined when it doesn't read. */
export function katanaTotalPages(header: string | null): number | undefined {
  let parsed: unknown;
  try {
    // A missing header parses as null.
    parsed = JSON.parse(header!);
  } catch {
    return undefined;
  }
  // Katana writes the counts as strings of digits.
  const raw = (parsed as Record<string, unknown> | null)?.total_pages;
  const total = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : raw;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

export function katanaClient(options: KatanaClientOptions): KatanaClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!API_KEY.test(apiKey)) throw new KatanaConfigError("KATANA_API_KEY is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  async function list(path: string, what: string, params: URLSearchParams, page: number): Promise<KatanaPage> {
    if (!Number.isSafeInteger(page) || page < 1) throw new KatanaApiError("a page must be a whole number from 1", 0);
    params.set("limit", String(KATANA_PAGE_SIZE));
    params.set("page", String(page));
    const url = `${KATANA_API_URL}${path}?${params}`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
      if (!RETRIED.has(response.status) || attempt >= retries) break;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
    const { status } = response;
    if (status === 401 || status === 403) throw new KatanaConfigError(`Katana turned down KATANA_API_KEY (HTTP ${status})`);
    if (status !== 200) throw new KatanaApiError(`Katana answered HTTP ${status} for ${what}`, status);
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | null | undefined;
    if (!Array.isArray(body?.data)) throw new KatanaApiError(`Katana answered without its ${what}`, status);
    const rows = body!.data as unknown[];
    const total = katanaTotalPages(response.headers.get("x-pagination"));
    // Without the header, a full page means another may follow.
    return { rows, more: total === undefined ? rows.length >= KATANA_PAGE_SIZE : page < total };
  }

  return {
    manufacturingOrders(query, page) {
      if (query.field !== "created_at_min" && query.field !== "updated_at_min") return Promise.reject(new KatanaApiError("manufacturing orders are listed by created_at_min or updated_at_min", 0));
      if (!UTC_TIME.test(query.since)) return Promise.reject(new KatanaApiError("manufacturing orders are listed from an ISO UTC time", 0));
      const params = new URLSearchParams({ include_deleted: "true", [query.field]: query.since });
      return list("/manufacturing_orders", "manufacturing orders", params, page);
    },
    inventory(page) {
      return list("/inventory", "inventory", new URLSearchParams({ extend: "variant" }), page);
    },
  };
}
