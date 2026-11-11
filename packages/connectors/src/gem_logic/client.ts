/**
 * A small client for Gem Logic's API, read-only. Each business has its own
 * instance at https://{instance}.gem-logic.com, and a request is signed in
 * with an API key made under Settings > API, sent in the `x-api-key` header.
 *
 * Gem Logic's keys have no permissions to choose: a key that can list
 * products can also make sales and repairs. So the client keeps to the reads
 * itself: it sends only GET requests to the sales channels (marketplaces)
 * and each channel's products, on the one instance the settings name.
 *
 * Gem Logic's own error text is never put in an error here, only the HTTP
 * status. A 429 and 500, 502, 503 and 504 are waited out a few times,
 * honoring Retry-After, before the error goes to runSync, which keeps the
 * checkpoint.
 */

const MAX_RETRY_AFTER_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
/** A business's instance, as in example.gem-logic.com. */
const INSTANCE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY = /^[A-Za-z0-9._~+/=-]{16,512}$/;
/** A sales channel's ID, as it goes in the products path. */
const CHANNEL_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface GemLogicClientOptions {
  /** A Gem Logic API key. Sent to the business's instance only, and never logged or shown. */
  apiKey: string;
  /** The instance, as a name, a host or a URL: example, example.gem-logic.com. */
  instance: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 or 5xx is retried here before the error goes to runSync. */
  retries?: number;
}

export class GemLogicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GemLogicConfigError";
  }
}

export class GemLogicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GemLogicApiError";
  }
}

export interface GemLogicPage {
  records: unknown[];
  /** A later page may hold more. */
  more: boolean;
}

export interface GemLogicClient {
  readonly baseUrl: string;
  /** Every sales channel. */
  marketplaces(): Promise<unknown[]>;
  /** One page of a channel's products; pages count from 1. */
  products(marketplaceId: string, page: number): Promise<GemLogicPage>;
}

/** The instance from a setting written as a name, a host or a URL, or null. */
export function gemLogicInstance(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/$/, "")
    .replace(/\.gem-logic\.com$/, "");
  return INSTANCE.test(name) ? name : null;
}

export function gemLogicClient(options: GemLogicClientOptions): GemLogicClient {
  const key = options.apiKey?.trim() ?? "";
  if (!KEY.test(key)) throw new GemLogicConfigError("GEM_LOGIC_API_KEY is missing or not in the expected shape");
  const instance = gemLogicInstance(options.instance ?? "");
  if (!instance) throw new GemLogicConfigError("GEM_LOGIC_INSTANCE must be the business's instance, like example in example.gem-logic.com");
  const baseUrl = `https://${instance}.gem-logic.com/api`;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;

  /** The records a list answered, and whether it says more follow. */
  async function get(path: string, what: string): Promise<GemLogicPage> {
    const init: RequestInit = { method: "GET", headers: { "x-api-key": key, accept: "application/json" } };
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await doFetch(`${baseUrl}${path}`, init);
      if (!RETRIED.has(response.status) || attempt >= retries) break;
      const after = Number(response.headers.get("retry-after"));
      await sleep(after > 0 ? 1000 * Math.min(after, MAX_RETRY_AFTER_S) : 1000 * 2 ** attempt);
    }
    const { status } = response;
    if (status === 401 || status === 403) throw new GemLogicConfigError(`Gem Logic turned down GEM_LOGIC_API_KEY for ${what} (HTTP ${status}); check the key is active on this instance`);
    if (status !== 200) throw new GemLogicApiError(`Gem Logic answered HTTP ${status} for ${what}`, status);
    const body = (await response.json().catch(() => null)) as unknown;
    // The docs show a plain list; a paged answer lists them under results, with next while more follow.
    if (Array.isArray(body)) return { records: body, more: false };
    const results = (body as Record<string, unknown> | null)?.results;
    if (!Array.isArray(results)) throw new GemLogicApiError(`Gem Logic answered without a list of ${what}`, status);
    const next = (body as Record<string, unknown>).next;
    return { records: results, more: typeof next === "string" && next !== "" };
  }

  return {
    baseUrl,
    async marketplaces() {
      return (await get("/marketplaces/", "sales channels")).records;
    },
    async products(marketplaceId, page) {
      if (!CHANNEL_ID.test(marketplaceId)) throw new GemLogicApiError("not a sales channel ID", 0);
      if (!Number.isSafeInteger(page) || page < 1) throw new GemLogicApiError("page must be a whole number, 1 or more", 0);
      return get(`/products/${marketplaceId}?page=${page}`, "products");
    },
  };
}
