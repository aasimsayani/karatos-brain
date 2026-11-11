/**
 * A small client for the Search The Watch Market Business API, for market
 * prices of the watch references a store buys and sells. The API is
 * read-only: every route is a GET under /data with the account's key as a
 * Bearer token. The client sends only these:
 *
 * - `GET /data/resolve?q=`: a reference or name to a model group;
 * - `GET /data/model/{group_id}/prices`: the latest price snapshot;
 * - `GET /data/model/{group_id}/days-to-sell`: how many days half, and
 *   95%, of listings take to sell;
 * - `GET /data/model/{group_id}/history`: up to 13 weeks of prices.
 *
 * A plan allows 1,000 or 5,000 calls a day, shared with the vendor's AI
 * assistant access, and answers 429 past it. So a 429 isn't retried (it
 * lasts until midnight UTC) and goes to runSync, which keeps the
 * checkpoint; the allowance left, from `X-RateLimit-Remaining`, is kept so
 * the connector can stop before using it all. A 500 or 503 is waited out a
 * few times (five seconds at first, doubling). A 404 is "no data", not an
 * error. Calls are spaced a quarter second apart.
 */

export const STWM_BASE = "https://data.searchthewatchmarket.com";
/** Calls are spaced this far apart. */
export const STWM_SPACING_MS = 250;
const RETRIED = new Set([500, 503]);
const API_KEY = /^[A-Za-z0-9_.-]{16,200}$/;

export interface StwmClientOptions {
  /** The Business API key (STWM_API_KEY). Sent to Search The Watch Market only, and never logged or shown. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before a call or a retry; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock calls are spaced by; replaced in tests. */
  clock?: () => number;
  /** Times a 500 or 503 is retried here before the error goes to runSync. */
  retries?: number;
}

export class StwmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StwmConfigError";
  }
}

export class StwmApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StwmApiError";
  }
}

/** A reference or name resolved to the model group the API prices. */
export interface StwmModel {
  groupId: number;
  brand: string | undefined;
  modelNumber: string | undefined;
  name: string | undefined;
}

export interface StwmClient {
  /** The model group a reference or name stands for, or null when nothing matches. */
  resolve(query: string): Promise<StwmModel | null>;
  /** The latest prices, days to sell and weekly history of a model group; each null when the API has none. */
  prices(groupId: number): Promise<unknown>;
  daysToSell(groupId: number): Promise<unknown>;
  history(groupId: number): Promise<unknown>;
  /** Calls left today, as the last answer said, or null before any answer said. */
  remaining(): number | null;
}

/** Text the API answers, trimmed, without markup, up to 120 characters. */
export const stwmText = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t !== "" && t.length <= 120 && !/[<>\p{Cc}]/u.test(t) ? t : undefined;
};

export function stwmClient(options: StwmClientOptions): StwmClient {
  const key = options.apiKey?.trim() ?? "";
  if (!API_KEY.test(key)) throw new StwmConfigError("STWM_API_KEY is missing or not in the expected shape");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const retries = options.retries ?? 3;
  let lastCall = Number.NEGATIVE_INFINITY;
  let left: number | null = null;

  /** One GET, spaced from the last and retried on a 500 or 503; null on a 404. */
  async function get(path: string, what: string): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + STWM_SPACING_MS - clock();
      if (wait > 0) await sleep(wait);
      lastCall = clock();
      const response = await doFetch(`${STWM_BASE}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      });
      const header = response.headers.get("x-ratelimit-remaining");
      if (header !== null && /^\d{1,9}$/.test(header)) left = Number(header);
      if (RETRIED.has(response.status) && attempt < retries) {
        await sleep(5000 * 2 ** attempt);
        continue;
      }
      if (response.status === 401) throw new StwmConfigError("Search The Watch Market turned down STWM_API_KEY: check it and that the subscription is active");
      if (response.status === 429) throw new StwmApiError("Search The Watch Market's daily allowance is used up; the sync goes on after midnight UTC", 429);
      if (response.status === 404) return null;
      if (response.status !== 200) throw new StwmApiError(`Search The Watch Market answered HTTP ${response.status} for ${what}`, response.status);
      const body = (await response.json().catch(() => undefined)) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body) || (body as { status?: unknown }).status !== 1) {
        throw new StwmApiError(`Search The Watch Market answered ${what} with something other than a success`, 200);
      }
      return body as Record<string, unknown>;
    }
  }

  const model = async (groupId: number, part: string) => {
    if (!Number.isSafeInteger(groupId) || groupId < 1) throw new StwmApiError("a model group must be a whole number above zero", 0);
    return get(`/data/model/${groupId}/${part}`, `the ${part.replace(/-/g, " ")} of a model`);
  };

  return {
    async resolve(query) {
      const q = stwmText(query);
      if (q === undefined) throw new StwmApiError("a reference must be plain text up to 120 characters", 0);
      const body = await get(`/data/resolve?${new URLSearchParams({ q })}`, "a reference");
      if (body === null) return null;
      if (!Number.isSafeInteger(body.group_id) || (body.group_id as number) < 1) throw new StwmApiError("Search The Watch Market resolved a reference without a model group", 200);
      return {
        groupId: body.group_id as number,
        brand: stwmText(body.brand),
        modelNumber: stwmText(body.model_number),
        name: stwmText(body.display_name),
      };
    },
    prices: (groupId) => model(groupId, "prices"),
    daysToSell: (groupId) => model(groupId, "days-to-sell"),
    history: (groupId) => model(groupId, "history"),
    remaining: () => left,
  };
}
