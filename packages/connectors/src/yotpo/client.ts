/**
 * A small client for Yotpo's Reviews API (v1) and Loyalty API (v2). Yotpo
 * gives each store one API secret and, for Loyalty, one GUID and API key.
 * Neither can be limited to reading: the same secret can moderate and
 * reply to reviews, and the same Loyalty key can adjust points and create
 * redemptions. So this client is what keeps KaratOS to reading. It sends
 * only the token request and two GETs, to Yotpo's fixed addresses, with
 * filters it builds itself from checked values.
 *
 * Yotpo allows 5 requests a second per store and answers 429 past it, with
 * Retry-After in seconds; that and 500, 502, 503 and 504 are waited out a
 * few times before the error goes to runSync, which keeps the checkpoint.
 */

export const YOTPO_API_URL = "https://api.yotpo.com";
export const YOTPO_LOYALTY_URL = "https://loyalty.yotpo.com/api/v2";
/** Reviews asked for at a time: the most Yotpo returns. */
export const YOTPO_REVIEW_PAGE = 100;
/** Loyalty customers asked for at a time: the most Yotpo returns. */
export const YOTPO_LOYALTY_PAGE = 500;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Loyalty's page cursors. */
export const YOTPO_PAGE_INFO = /^[A-Za-z0-9_=-]{1,512}$/;
/** Pages read per pass at most, so a page number never runs away. */
export const YOTPO_MAX_PAGE = 10_000;

export interface YotpoClientOptions {
  /** The store ID, also called the app key. */
  storeId: string;
  /** Sent to Yotpo only, and never logged or shown. */
  apiSecret: string;
  /** Loyalty's GUID and API key; both or neither. */
  loyaltyGuid?: string | undefined;
  loyaltyApiKey?: string | undefined;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class YotpoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YotpoConfigError";
  }
}

/** Yotpo answered with an error. `code` is Yotpo's own error code, when it gave one. */
export class YotpoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "YotpoApiError";
  }
}

export interface YotpoLoyaltyPage {
  rows: unknown[];
  /** The cursor for the next page, or null when this was the last. */
  next: string | null;
}

export interface YotpoClient {
  /** Whether Loyalty's credentials were given. */
  readonly loyalty: boolean;
  /** One page (from 1) of the store's reviews updated since a day (YYYY-MM-DD), unpublished ones included. */
  reviews(sinceUpdated: string, page: number): Promise<unknown[]>;
  /** One page of the Loyalty customers updated in the last seven days. */
  loyaltyCustomers(pageInfo: string | null): Promise<YotpoLoyaltyPage>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Yotpo's error code, from its {status: {code}} or {code} body. */
export function yotpoErrorCode(body: unknown): number | undefined {
  const status = isObject(body) && isObject(body.status) ? body.status : body;
  const code = isObject(status) ? status.code : undefined;
  return Number.isSafeInteger(code) && (code as number) > 0 ? (code as number) : undefined;
}

export function yotpoClient(options: YotpoClientOptions): YotpoClient {
  const storeId = options.storeId?.trim() ?? "";
  if (!/^[A-Za-z0-9]{10,64}$/.test(storeId)) throw new YotpoConfigError("YOTPO_STORE_ID is missing or not in the expected shape");
  const apiSecret = options.apiSecret?.trim() ?? "";
  if (!/^[A-Za-z0-9]{20,128}$/.test(apiSecret)) throw new YotpoConfigError("YOTPO_API_SECRET is missing or not in the expected shape");
  const guid = options.loyaltyGuid?.trim() ?? "";
  const loyaltyKey = options.loyaltyApiKey?.trim() ?? "";
  if ((guid === "") !== (loyaltyKey === "")) throw new YotpoConfigError("YOTPO_LOYALTY_GUID and YOTPO_LOYALTY_API_KEY go together: give both or neither");
  if (guid && !/^[A-Za-z0-9_-]{10,64}$/.test(guid)) throw new YotpoConfigError("YOTPO_LOYALTY_GUID is not in the expected shape");
  if (loyaltyKey && !/^[A-Za-z0-9_-]{16,128}$/.test(loyaltyKey)) throw new YotpoConfigError("YOTPO_LOYALTY_API_KEY is not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  let token: string | null = null;

  /** Sends a request, waiting out rate limits and server errors, and reads its JSON. */
  async function send(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, init);
      if (RETRIED.has(response.status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
        continue;
      }
      return { status: response.status, body: await response.json().catch(() => undefined) };
    }
  }

  async function accessToken(): Promise<string> {
    if (token) return token;
    const { status, body } = await send(`${YOTPO_API_URL}/core/v3/stores/${storeId}/access_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ secret: apiSecret }),
    });
    if (status === 401 || status === 403 || status === 404) throw new YotpoConfigError(`Yotpo turned down the store's credentials (HTTP ${status}): check YOTPO_STORE_ID and YOTPO_API_SECRET`);
    const value = (body as Record<string, unknown> | undefined)?.access_token;
    if (status !== 200 || typeof value !== "string" || !/^[A-Za-z0-9._-]{16,4096}$/.test(value)) throw new YotpoApiError(`Yotpo answered the token request with HTTP ${status} and no token`, status, yotpoErrorCode(body));
    token = value;
    return token;
  }

  function check(status: number, body: unknown, what: string, credentials: string): Record<string, unknown> {
    const code = yotpoErrorCode(body);
    const why = code ? ` (code ${code})` : "";
    if (status === 401) throw new YotpoApiError(`Yotpo turned down ${credentials} for ${what}${why}`, 401, code);
    if (status !== 200) throw new YotpoApiError(`Yotpo answered HTTP ${status} for ${what}${why}`, status, code);
    if (!isObject(body)) throw new YotpoApiError(`Yotpo answered ${what} with a body that isn't a JSON object`, 200);
    return body;
  }

  return {
    loyalty: guid !== "",
    async reviews(sinceUpdated, page) {
      if (!DAY.test(sinceUpdated)) throw new YotpoApiError("reviews must be listed since a YYYY-MM-DD day", 0);
      if (!Number.isSafeInteger(page) || page < 1 || page > YOTPO_MAX_PAGE) throw new YotpoApiError(`a reviews page must be 1 to ${YOTPO_MAX_PAGE}`, 0);
      const url = new URL(`${YOTPO_API_URL}/v1/apps/${storeId}/reviews`);
      url.searchParams.set("since_updated_at", sinceUpdated);
      url.searchParams.set("count", String(YOTPO_REVIEW_PAGE));
      url.searchParams.set("page", String(page));
      url.searchParams.set("deleted", "true");
      const bearer = await accessToken();
      const { status, body } = await send(url.toString(), { method: "GET", headers: { "X-Yotpo-Token": bearer, accept: "application/json" } });
      // A token Yotpo no longer takes is dropped, so the next read asks for a new one.
      if (status === 401) token = null;
      const reviews = check(status, body, "the reviews", "the access token").reviews;
      if (!Array.isArray(reviews)) throw new YotpoApiError("Yotpo answered the reviews without the reviews list", 200);
      return reviews;
    },
    async loyaltyCustomers(pageInfo) {
      if (!guid) throw new YotpoConfigError("Yotpo Loyalty isn't set up: give YOTPO_LOYALTY_GUID and YOTPO_LOYALTY_API_KEY");
      if (pageInfo !== null && !YOTPO_PAGE_INFO.test(pageInfo)) throw new YotpoApiError("a Loyalty page cursor is not in the expected shape", 0);
      const url = new URL(`${YOTPO_LOYALTY_URL}/customers/recent`);
      url.searchParams.set("per_page", String(YOTPO_LOYALTY_PAGE));
      if (pageInfo) url.searchParams.set("page_info", pageInfo);
      const { status, body } = await send(url.toString(), { method: "GET", headers: { "X-GUID": guid, "X-API-KEY": loyaltyKey, accept: "application/json" } });
      const page = check(status, body, "the Loyalty customers", "the Loyalty GUID and API key");
      if (!Array.isArray(page.customers)) throw new YotpoApiError("Yotpo answered the Loyalty customers without the customers list", 200);
      const next = (page.metadata as Record<string, unknown> | undefined)?.next_page_info;
      if (next === undefined || next === null || next === "") return { rows: page.customers, next: null };
      if (typeof next !== "string" || !YOTPO_PAGE_INFO.test(next)) throw new YotpoApiError("Yotpo answered the Loyalty customers with a page cursor that doesn't read", 200);
      return { rows: page.customers, next };
    },
  };
}
