/**
 * A small client for Birdeye's review API. Birdeye issues one kind of API
 * key, from the business's Birdeye dashboard, and its docs describe no way
 * to limit it to reading, so this client is what keeps KaratOS to reading:
 * the only request it sends is Get Reviews for the configured business
 * (a search sent as a POST), with a body it builds itself. It never replies
 * to a review, sends a review request, or touches contacts or messages.
 *
 * Birdeye answers its rate limit with 429 (code 89); that and 502 to 504
 * are waited out a few times before the error goes to runSync, which keeps
 * the checkpoint.
 */

export const BIRDEYE_API_URL = "https://api.birdeye.com/resources/v1";
/** Reviews asked for at a time. */
export const BIRDEYE_PAGE_SIZE = 100;
/** Birdeye won't page past this many records (sindex plus count). */
export const BIRDEYE_MAX_WINDOW = 100_000;
const MAX_RETRY_AFTER_S = 60;
/** A day as Birdeye's filters take it. */
const DAY = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;

export interface BirdeyeClientOptions {
  /** Sent to Birdeye only and never logged or shown. */
  apiKey: string;
  /** The Birdeye business (location) whose reviews are read. */
  businessId: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class BirdeyeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BirdeyeConfigError";
  }
}

/** Birdeye answered with an error. `code` is Birdeye's own error code, when it gave one. */
export class BirdeyeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "BirdeyeApiError";
  }
}

export interface BirdeyeReviewQuery {
  /** Reviews posted on or after this day (MM/dd/yyyy), for the first import. */
  fromDate?: string;
  /** Reviews changed on or after this day (MM/dd/yyyy), for later syncs. */
  updateFromDate?: string;
  sindex: number;
}

export interface BirdeyeClient {
  /** One page of the business's reviews, published and parked alike. */
  reviews(query: BirdeyeReviewQuery): Promise<Record<string, unknown>[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Birdeye's error code, from its {code, message} body. */
export function birdeyeErrorCode(body: unknown): number | undefined {
  const code = isObject(body) ? body.code : undefined;
  return Number.isSafeInteger(code) && (code as number) >= 0 ? (code as number) : undefined;
}

export function birdeyeClient(options: BirdeyeClientOptions): BirdeyeClient {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!/^\S{16,512}$/.test(apiKey)) throw new BirdeyeConfigError("BIRDEYE_API_KEY is missing or not in the expected shape");
  const businessId = options.businessId?.trim() ?? "";
  if (!/^[1-9]\d{0,17}$/.test(businessId)) throw new BirdeyeConfigError("BIRDEYE_BUSINESS_ID must be the business's numeric id");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  return {
    async reviews(query) {
      if (!Number.isSafeInteger(query.sindex) || query.sindex < 0) throw new BirdeyeConfigError("sindex must be a whole number from 0");
      if (query.sindex + BIRDEYE_PAGE_SIZE > BIRDEYE_MAX_WINDOW) throw new BirdeyeApiError(`Birdeye won't page past ${BIRDEYE_MAX_WINDOW} reviews in one read`, 400);
      if ((query.fromDate === undefined) === (query.updateFromDate === undefined)) throw new BirdeyeConfigError("give one of fromDate or updateFromDate");
      const day = query.fromDate ?? query.updateFromDate!;
      if (!DAY.test(day)) throw new BirdeyeConfigError("dates must be MM/dd/yyyy");
      const body = JSON.stringify({ ...(query.fromDate ? { fromDate: day } : { updateFromDate: day }), statuses: ["all"] });
      const url = `${BIRDEYE_API_URL}/review/businessId/${businessId}?sindex=${query.sindex}&count=${BIRDEYE_PAGE_SIZE}`;
      for (let attempt = 0; ; attempt++) {
        // Get Reviews is a search sent as a POST. It is the only call the connector makes.
        const response = await doFetch(url, { method: "POST", headers: { "x-api-key": apiKey, accept: "application/json", "content-type": "application/json" }, body });
        const busy = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
        if (busy && attempt < retries) {
          const after = response.headers.get("retry-after");
          const seconds = after !== null && /^\d{1,6}$/.test(after.trim()) ? Number(after.trim()) : 0;
          await sleep(1000 * (seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : 2 ** attempt));
          continue;
        }
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          parsed = undefined;
        }
        const code = birdeyeErrorCode(parsed);
        if (response.status === 429) throw new BirdeyeApiError("Birdeye kept rate-limiting the review reads; the next sync picks up from the checkpoint", 429, code);
        if (response.status === 401) throw new BirdeyeApiError("Birdeye turned down the API key: check BIRDEYE_API_KEY", 401, code);
        if (response.status === 404) throw new BirdeyeApiError("Birdeye doesn't know that business: check BIRDEYE_BUSINESS_ID", 404, code);
        if (response.status !== 200) throw new BirdeyeApiError(`Birdeye reviews answered HTTP ${response.status}${code !== undefined ? ` (code ${code})` : ""}`, response.status, code);
        if (!Array.isArray(parsed)) throw new BirdeyeApiError("Birdeye reviews answered without a list", 200);
        return parsed.filter(isObject);
      }
    },
  };
}
