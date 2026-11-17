/**
 * A small client for the Whatnot Seller API (REST v2). Requests carry a
 * seller's API token as a bearer token: a personal access token
 * (`wn_pat_tk_...`) the account owner creates in the developer dashboard,
 * or an OAuth app token (`wn_access_tk_...`). Whatnot tokens carry scopes,
 * and this connector needs only `read:orders` and `read:inventory`. Read-only
 * is enforced here too, in code: the client sends GET requests to four list
 * endpoints, with query strings it builds itself, and has no way to send
 * anything else.
 *
 * Errors come back as RFC 9457 problem details, {type, title, status,
 * detail}. Whatnot allows 10 requests a second per seller and app and
 * answers 429 with Retry-After past that; a 429 or 5xx is retried with
 * backoff before the error goes to runSync.
 */

export const WHATNOT_API_BASE = "https://api.whatnot.com/seller-api/rest/v2";
/** Items asked for per page: the most a Whatnot list returns. */
export const WHATNOT_PAGE_SIZE = 50;
/** Every request carries a User-Agent naming the integration. */
export const WHATNOT_USER_AGENT = "KaratOS/1.0 (+https://github.com/aasimsayani/karatos-brain)";
/** The only scopes the connector needs. */
export const WHATNOT_SCOPES = ["read:orders", "read:inventory"] as const;

/**
 * Whatnot documents the two token prefixes and nothing about the rest of
 * the token, so after the prefix any 8 to 512 visible ASCII characters are
 * accepted.
 */
const TOKEN = /^wn_(?:pat|access)_tk_[!-~]{8,512}$/;
/** An order id, as the Get Order page gives its pattern. */
const ORDER_ID = /^[1-9][0-9]{0,18}$/;
/** The docs give no pattern for product ids; their examples are numeric strings. */
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The list endpoints take a cursor of at most 2048 characters. */
const CURSOR_MAX = 2048;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface WhatnotClientOptions {
  /** The seller's API token. It is never logged or shown. */
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class WhatnotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatnotConfigError";
  }
}

/** Whatnot answered with an error. `type` is the problem type, such as rate-limited, when it gives one that reads. */
export class WhatnotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
  ) {
    super(message);
    this.name = "WhatnotApiError";
  }
}

/** One page of a list: its rows and Whatnot's cursor for the next page, null after the last. */
export interface WhatnotPage {
  data: unknown[];
  nextCursor: string | null;
}

export interface WhatnotListRequest {
  /** Whatnot's cursor from the previous page, or null for the first. */
  cursor: string | null;
  /** Newest first when true, oldest first when false. */
  reverse: boolean;
}

export interface WhatnotClient {
  orders(request: WhatnotListRequest): Promise<WhatnotPage>;
  /** An order's line items, oldest first. */
  orderItems(orderId: string, cursor: string | null): Promise<WhatnotPage>;
  products(request: WhatnotListRequest): Promise<WhatnotPage>;
  /** A product's variants, oldest first. */
  variants(productId: string, cursor: string | null): Promise<WhatnotPage>;
}

export const isWhatnotCursor = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= CURSOR_MAX;

/** The problem's type and detail, cut short. Problem bodies describe the request, never the token. */
function detail(body: unknown): { type: string | undefined; text: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as { type?: unknown; detail?: unknown; title?: unknown };
  const type = typeof b.type === "string" && /^[a-z-]{1,64}$/.test(b.type) ? b.type : undefined;
  const said = typeof b.detail === "string" ? b.detail : typeof b.title === "string" ? b.title : "";
  const message = said.slice(0, 200);
  return { type, text: `${type ? ` (${type})` : ""}${message ? `: ${message}` : ""}` };
}

export function whatnotClient(options: WhatnotClientOptions): WhatnotClient {
  const token = options.accessToken?.trim() ?? "";
  if (!TOKEN.test(token)) throw new WhatnotConfigError("set WHATNOT_ACCESS_TOKEN to a Whatnot seller API token, which starts wn_pat_tk_ or wn_access_tk_");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const authorization = `Bearer ${token}`;

  async function get(path: string, what: string, cursor: string | null, reverse: boolean): Promise<WhatnotPage> {
    if (cursor !== null && !isWhatnotCursor(cursor)) throw new WhatnotApiError(`a cursor for the ${what} must be 1 to ${CURSOR_MAX} characters`, 0);
    const query = new URLSearchParams({ limit: String(WHATNOT_PAGE_SIZE), reverse: String(reverse) });
    if (cursor !== null) query.set("cursor", cursor);
    const url = `${WHATNOT_API_BASE}${path}?${query}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with the token in the Authorization header and never in the URL.
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json", authorization, "user-agent": WHATNOT_USER_AGENT } });
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      const { type, text } = detail(body);
      if (response.status === 401 || response.status === 403) {
        throw new WhatnotConfigError(`Whatnot turned down the access token (HTTP ${response.status})${text}; WHATNOT_ACCESS_TOKEN must be a Whatnot seller API token with the ${WHATNOT_SCOPES.join(" and ")} scopes`);
      }
      if (response.status !== 200) throw new WhatnotApiError(`Whatnot answered HTTP ${response.status} for the ${what}${text}`, response.status, type);
      const page = body as { data?: unknown; next_cursor?: unknown } | null;
      const data = page?.data;
      const next = page?.next_cursor ?? null;
      if (!Array.isArray(data) || (next !== null && !isWhatnotCursor(next))) throw new WhatnotApiError(`Whatnot answered the ${what} without a page that reads`, 200);
      if (next !== null && next === cursor) throw new WhatnotApiError(`Whatnot answered the ${what} with the same cursor again`, 200);
      return { data, nextCursor: next };
    }
  }

  const orderPath = (orderId: string) => {
    if (!ORDER_ID.test(orderId)) throw new WhatnotApiError("an order id must be a number Whatnot gave", 0);
    return `/orders/${orderId}/items`;
  };
  const productPath = (productId: string) => {
    if (!PRODUCT_ID.test(productId)) throw new WhatnotApiError("a product id must be one Whatnot gave", 0);
    return `/products/${productId}/variants`;
  };

  return {
    orders: ({ cursor, reverse }) => get("/orders", "orders", cursor, reverse),
    orderItems: async (orderId, cursor) => get(orderPath(orderId), "order items", cursor, false),
    products: ({ cursor, reverse }) => get("/products", "products", cursor, reverse),
    variants: async (productId, cursor) => get(productPath(productId), "variants", cursor, false),
  };
}
