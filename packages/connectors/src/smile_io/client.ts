/**
 * A small client for Smile.io's REST API: one store's loyalty program. It
 * uses a merchant API key the store made with only read scopes
 * (customer:read, points_transaction:read and vip_tier:read) and sends
 * only these requests, all GETs, to `https://api.smile.io/v1`:
 *
 * - `GET /vip_tiers`;
 * - `GET /customers`, with their VIP status, changed since a time;
 * - `GET /points_transactions`, changed since a time.
 *
 * Smile scopes each key, and a key with only read scopes can't change a
 * balance. Smile has no call that lists a key's scopes, so the setup asks
 * for read scopes only and the client has no request that writes. Every
 * request is built here from checked values and Smile's page cursor, never
 * from a link in an answer.
 */

/** Records asked for at a time: Smile's largest page. */
export const SMILE_PAGE_SIZE = 250;
/** The scopes the key needs, and all it should have. */
export const SMILE_READ_SCOPES = ["customer:read", "points_transaction:read", "vip_tier:read"] as const;
const BASE = "https://api.smile.io/v1";
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 503]);
const API_KEY = /^api_[A-Za-z0-9_-]{8,256}$/;
/** Smile's page cursor, as it writes them. */
export const SMILE_CURSOR = /^[A-Za-z0-9_.~=+/-]{1,2048}$/;

export type SmileList = "customers" | "points_transactions";

export interface SmileClientOptions {
  /** The store's merchant API key (SMILE_API_KEY). Sent to Smile only. */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a throttled request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429, 500 or 503 is retried here before the error goes to runSync. */
  retries?: number;
}

export class SmileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmileConfigError";
  }
}

/** Smile answered with an error. */
export class SmileApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SmileApiError";
  }
}

export interface SmilePage {
  rows: unknown[];
  /** The cursor of the next page, or null when this was the last. */
  next: string | null;
}

export interface SmileClient {
  /** The program's VIP tiers. */
  vipTiers(): Promise<unknown[]>;
  /** One page of a list, newest first, of records changed at or after `since` (ISO), or of all of them. */
  page(list: SmileList, since: string | null, cursor: string | null): Promise<SmilePage>;
}

const SCOPE: Record<string, string> = { vip_tiers: "vip_tier:read", customers: "customer:read", points_transactions: "points_transaction:read" };

export function smileClient(options: SmileClientOptions): SmileClient {
  const key = options.apiKey?.trim() ?? "";
  if (!API_KEY.test(key)) throw new SmileConfigError("SMILE_API_KEY is missing or not in the expected shape: a merchant API key starts with api_");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = options.retries ?? 3;

  async function get(path: string, query: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
      const { status } = response;
      if (RETRIED.has(status) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(after > 0 ? 1000 * Math.min(after, MAX_WAIT_S) : 1000 * 2 ** attempt);
        continue;
      }
      if (status === 401) throw new SmileConfigError("Smile turned down SMILE_API_KEY: check it, and that the store is still on a plan with API access");
      if (status === 403) throw new SmileConfigError(`SMILE_API_KEY can't read ${path}: make a key with ${SCOPE[path]}`);
      if (status !== 200) throw new SmileApiError(`Smile answered HTTP ${status} for ${path}`, status);
      const body = ((await response.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
      if (!Array.isArray(body[path])) throw new SmileApiError(`Smile answered ${path} without a list`, 200);
      return body;
    }
  }

  return {
    vipTiers: async () => (await get("vip_tiers", {})).vip_tiers as unknown[],
    async page(list, since, cursor) {
      if (cursor !== null && !SMILE_CURSOR.test(cursor)) throw new SmileApiError("Smile's page cursor isn't in the expected shape", 0);
      if (since !== null && Number.isNaN(Date.parse(since))) throw new SmileApiError("a list's start must be a time", 0);
      const query: Record<string, string> = { limit: String(SMILE_PAGE_SIZE) };
      if (list === "customers") query.include = "vip_status";
      if (since) query.updated_at_min = since;
      if (cursor) query.cursor = cursor;
      const body = await get(list, query);
      const next = (body.metadata as Record<string, unknown> | null | undefined)?.next_cursor;
      if (next !== null && (typeof next !== "string" || !SMILE_CURSOR.test(next))) throw new SmileApiError(`Smile's ${list} page had no next cursor in the expected shape`, 200);
      return { rows: body[list] as unknown[], next };
    },
  };
}
