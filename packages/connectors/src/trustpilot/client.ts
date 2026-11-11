/**
 * A small client for Trustpilot's public Business Units API (v1). It uses
 * only the application's API key, sent in the `apikey` header, and never
 * the API secret: the key alone reaches only Trustpilot's public endpoints,
 * which read what anyone can see on the store's Trustpilot page. Replying
 * to a review or sending an invitation needs a business user's OAuth token,
 * made with the secret, so a client holding only the key can't write.
 *
 * It sends two kinds of request, both GETs to Trustpilot's fixed address
 * with parameters it builds itself from checked values:
 *
 * - `GET /business-units/{id}`: the store's trust score and review counts;
 * - `GET /business-units/{id}/reviews`: the store's service reviews, newest
 *   first, 100 a page by number.
 *
 * A 429 and 500, 502, 503 and 504 are waited out a few times, honoring
 * Retry-After, before the error goes to runSync, which keeps the checkpoint.
 */

export const TRUSTPILOT_API_URL = "https://api.trustpilot.com/v1";
/** Reviews asked for at a time. */
export const TRUSTPILOT_PAGE_SIZE = 100;
/** Pages read per pass at most, so a page number never runs away. */
export const TRUSTPILOT_MAX_PAGE = 1_000;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const API_KEY = /^[A-Za-z0-9]{20,64}$/;
/** A business unit id: 24 hexadecimal characters. */
export const TRUSTPILOT_BUSINESS_UNIT = /^[0-9a-f]{24}$/;

export interface TrustpilotClientOptions {
  /** The application's API key (TRUSTPILOT_API_KEY). Sent to Trustpilot only, and never logged or shown. */
  apiKey: string;
  /** The store's business unit id (TRUSTPILOT_BUSINESS_UNIT_ID). */
  businessUnitId: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class TrustpilotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustpilotConfigError";
  }
}

export class TrustpilotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TrustpilotApiError";
  }
}

export interface TrustpilotClient {
  /** The store's business unit: its trust score and review counts. */
  businessUnit(): Promise<unknown>;
  /** One page (from 1) of the store's service reviews, newest first. */
  reviews(page: number): Promise<unknown[]>;
}

export function trustpilotClient(options: TrustpilotClientOptions): TrustpilotClient {
  const key = options.apiKey?.trim() ?? "";
  if (!API_KEY.test(key)) throw new TrustpilotConfigError("TRUSTPILOT_API_KEY is missing or not in the expected shape: the API key of a Trustpilot application, not its secret");
  const unit = options.businessUnitId?.trim().toLowerCase() ?? "";
  if (!TRUSTPILOT_BUSINESS_UNIT.test(unit)) throw new TrustpilotConfigError("TRUSTPILOT_BUSINESS_UNIT_ID is missing or not a business unit id: 24 letters and digits from 0-9 and a-f");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  async function get(path: string, query: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    const url = new URL(`${TRUSTPILOT_API_URL}/business-units/${unit}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url.toString(), { method: "GET", headers: { apikey: key, accept: "application/json" } });
      const { status } = response;
      if (RETRIED.has(status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
        continue;
      }
      if (status === 401 || status === 403) throw new TrustpilotConfigError(`Trustpilot turned down TRUSTPILOT_API_KEY (HTTP ${status}): check it, and that the store still has the API module`);
      if (status === 404) throw new TrustpilotConfigError("Trustpilot has no business unit with TRUSTPILOT_BUSINESS_UNIT_ID");
      if (status !== 200) throw new TrustpilotApiError(`Trustpilot answered HTTP ${status} for ${what}`, status);
      const body = (await response.json().catch(() => undefined)) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new TrustpilotApiError(`Trustpilot answered ${what} without an object`, 200);
      return body as Record<string, unknown>;
    }
  }

  return {
    businessUnit: () => get("", {}, "the business unit"),
    async reviews(page) {
      if (!Number.isSafeInteger(page) || page < 1 || page > TRUSTPILOT_MAX_PAGE) throw new TrustpilotApiError(`a reviews page must be 1 to ${TRUSTPILOT_MAX_PAGE}`, 0);
      const body = await get("/reviews", { orderBy: "createdat.desc", perPage: String(TRUSTPILOT_PAGE_SIZE), page: String(page) }, "the reviews");
      if (!Array.isArray(body.reviews)) throw new TrustpilotApiError("Trustpilot answered the reviews without the reviews list", 200);
      return body.reviews;
    },
  };
}
