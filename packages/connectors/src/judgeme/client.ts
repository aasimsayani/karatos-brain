/**
 * A small client for Judge.me's REST API (v1). Judge.me gives each shop a
 * private API token, sent with the shop's domain on every request, and the
 * token reads and writes alike: it can also post reviews and change what is
 * published. An OAuth token can be limited to read_reviews, and the client
 * takes either. So this client is what keeps KaratOS to reading: it sends
 * only GETs of the review list, to Judge.me's fixed address, with a query it
 * builds itself from checked values.
 *
 * The token travels in the query string, as Judge.me documents, so no error
 * this client raises ever carries a URL. A 429 and 500, 502, 503 and 504
 * are waited out a few times, honoring Retry-After, before the error goes to
 * runSync, which keeps the checkpoint.
 */

export const JUDGEME_API_URL = "https://api.judge.me/api/v1";
/** Reviews asked for at a time: the most Judge.me returns. */
export const JUDGEME_REVIEW_PAGE = 100;
/** Pages read per pass at most, so a page number never runs away. */
export const JUDGEME_MAX_PAGE = 5_000;
const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);

export interface JudgemeClientOptions {
  /** The shop's domain, such as example.myshopify.com. */
  shopDomain: string;
  /** The private API token, or an OAuth token with read_reviews. Sent to Judge.me only, and never logged or shown. */
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class JudgemeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgemeConfigError";
  }
}

export class JudgemeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JudgemeApiError";
  }
}

export interface JudgemeClient {
  /** One page (from 1) of the shop's reviews. */
  reviews(page: number): Promise<unknown[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function judgemeClient(options: JudgemeClientOptions): JudgemeClient {
  const shopDomain = options.shopDomain?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){1,4}$/.test(shopDomain)) throw new JudgemeConfigError("JUDGEME_SHOP_DOMAIN is missing or not a domain such as example.myshopify.com");
  const apiToken = options.apiToken?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(apiToken)) throw new JudgemeConfigError("JUDGEME_API_TOKEN is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    async reviews(page) {
      if (!Number.isSafeInteger(page) || page < 1 || page > JUDGEME_MAX_PAGE) throw new JudgemeApiError(`a reviews page must be 1 to ${JUDGEME_MAX_PAGE}`, 0);
      const url = new URL(`${JUDGEME_API_URL}/reviews`);
      url.searchParams.set("shop_domain", shopDomain);
      url.searchParams.set("api_token", apiToken);
      url.searchParams.set("per_page", String(JUDGEME_REVIEW_PAGE));
      url.searchParams.set("page", String(page));
      let response: Response;
      for (let attempt = 0; ; attempt++) {
        response = await doFetch(url.toString(), { method: "GET", headers: { accept: "application/json" } });
        if (!RETRIED.has(response.status) || attempt >= retries) break;
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
      }
      const { status } = response;
      if (status === 401 || status === 403) throw new JudgemeConfigError(`Judge.me turned down the token (HTTP ${status}): check JUDGEME_API_TOKEN and JUDGEME_SHOP_DOMAIN`);
      if (status !== 200) throw new JudgemeApiError(`Judge.me answered HTTP ${status} for the reviews`, status);
      const body: unknown = await response.json().catch(() => undefined);
      if (!isObject(body) || !Array.isArray(body.reviews)) throw new JudgemeApiError("Judge.me answered the reviews without the reviews list", 200);
      // A page Judge.me says is another one would read the same reviews over and over.
      if (body.current_page !== undefined && Number(body.current_page) !== page) throw new JudgemeApiError(`Judge.me answered page ${String(body.current_page).slice(0, 12)} when asked for page ${page}`, 200);
      return body.reviews;
    },
  };
}
