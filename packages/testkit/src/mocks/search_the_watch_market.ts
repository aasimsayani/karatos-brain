import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockResponse } from "../doc-mock.js";

/**
 * The Search The Watch Market Business API's resolve, prices, days to sell
 * and history routes, built from the vendor's API reference. Data is
 * synthetic. The API needs a paid plan, so a client's key replaces this
 * mock on the first live run.
 *
 * Docs facts the mock relies on:
 * - Every /data route needs `Authorization: Bearer <key>`; a bad key is
 *   401 with status 0 and error "unauthorized".
 * - A success has status 1. GET /data/resolve?q= answers group_id, brand,
 *   model_number and display_name, or 404 not_found.
 * - GET /data/model/{group_id}/prices answers currency, listing_count, min,
 *   max, mean and market_value as whole numbers.
 * - GET /data/model/{group_id}/days-to-sell answers sell_within_50_days and
 *   sell_within_95_days, each left out when unknown, and 404 when both are.
 * - GET /data/model/{group_id}/history answers up to 13 weeks, each with
 *   week (YYYY-MM-DD), count, and mean, min and max keyed by currency.
 * - Plans allow 1,000 or 5,000 calls a day; answers carry
 *   X-RateLimit-Limit and X-RateLimit-Remaining, and 429 past the limit.
 */
const REFERENCE = "https://github.com/searchthewatchmarket/business-api/blob/HEAD/API_REFERENCE.md";
export const STWM_DOC_PAGES = { reference: REFERENCE } as const;
export const STWM_MOCK_BASE = "https://data.searchthewatchmarket.com";

export interface StwmMockModel {
  group_id: number;
  /** Names and references that resolve to this model, matched ignoring case. */
  matches: string[];
  brand: string;
  model_number: string;
  display_name: string;
  /** Mean asking price in USD; the rest are derived from it. */
  price: number;
  /** Days to sell; null leaves the route at 404. */
  days?: [number | undefined, number | undefined] | null;
  /** Weeks of history; 13 unless given. */
  weeks?: number;
}

export interface StwmMockData {
  apiKey: string;
  models?: StwmMockModel[];
  /** The day's allowance; 1000 unless given. */
  limit?: number;
}

/** A steel sports watch at about `price` dollars. */
export const stwmModel = (n: number, price = 12_000): StwmMockModel => ({
  group_id: 1000 + n,
  matches: [`TEST-${n}`, `Test Diver ${n}`],
  brand: "Testmaker",
  model_number: `TEST-${n}`,
  display_name: `Testmaker Test Diver ${n}`,
  price,
  days: [21, 90],
});

export interface StwmMock {
  api: DocMock;
  fetch: DocMockFetch;
  /** Calls left today. */
  readonly remaining: number;
}

/** The last 13 Mondays before the mock's fixed date, oldest first. */
const MONDAY = Date.parse("2026-11-09T00:00:00Z");
const WEEK_MS = 7 * 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function stwmDocMock(data: StwmMockData): StwmMock {
  const limit = data.limit ?? 1000;
  let used = 0;
  const models = () => data.models ?? [];
  const error = (status: number, code: string, message: string): DocMockResponse => ({ status, body: { status: 0, error: code, message } });

  /** Checks the key and the allowance, and counts the call. */
  function gate(request: { headers: Headers }): DocMockResponse | null {
    if (request.headers.get("authorization") !== `Bearer ${data.apiKey}`) return error(401, "unauthorized", "Missing or invalid API key");
    if (used >= limit) return error(429, "rate_limited", "Daily request limit reached");
    used++;
    return null;
  }
  const ok = (body: Record<string, unknown>): DocMockResponse => ({
    status: 200,
    body: { status: 1, ...body },
    headers: {
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": String(limit - used),
    },
  });
  const find = (id: string | undefined) => models().find((m) => String(m.group_id) === id);
  const notFound = () => error(404, "not_found", "Not found");

  const api = checkDocMock({
    integration: "search_the_watch_market",
    baseUrl: STWM_MOCK_BASE,
    auth: "bearer",
    source: {
      url: REFERENCE,
      title: "Search The Watch Market Data API Reference",
      retrievedOn: "2026-11-11",
      version: "2026-10-07",
    },
    assumptions: ["The API key is 16 to 200 letters, digits, _, . and -", "A week's date is the first day of the week", "A 429 answers with status 0 like other errors", "Prices are whole units of the currency, USD unless the account says otherwise"],
    routes: [
      {
        method: "GET",
        path: "/data/resolve",
        documentedAt: REFERENCE,
        respond(request) {
          const busy = gate(request);
          if (busy) return busy;
          const q = (request.url.searchParams.get("q") ?? "").trim().toLowerCase();
          if (q === "") return error(400, "invalid_input", "q is required");
          const m = models().find((x) => x.matches.some((name) => name.toLowerCase() === q));
          if (!m) return error(404, "not_found", "No matching group found");
          return ok({
            group_id: m.group_id,
            brand: m.brand,
            model_number: m.model_number,
            display_name: m.display_name,
          });
        },
      },
      {
        method: "GET",
        path: "/data/model/{group_id}/prices",
        documentedAt: REFERENCE,
        respond(request, params) {
          const busy = gate(request);
          if (busy) return busy;
          const m = find(params.group_id);
          if (!m) return notFound();
          return ok({
            group_id: m.group_id,
            currency: "USD",
            listing_count: 40,
            min: Math.round(m.price * 0.8),
            max: Math.round(m.price * 1.5),
            mean: m.price,
            market_value: Math.round(m.price * 0.95),
          });
        },
      },
      {
        method: "GET",
        path: "/data/model/{group_id}/days-to-sell",
        documentedAt: REFERENCE,
        respond(request, params) {
          const busy = gate(request);
          if (busy) return busy;
          const m = find(params.group_id);
          const days = m?.days === undefined ? [30, 120] : m.days;
          if (!m || days === null || (days[0] === undefined && days[1] === undefined)) return notFound();
          return ok({
            group_id: m.group_id,
            ...(days[0] === undefined ? {} : { sell_within_50_days: days[0] }),
            ...(days[1] === undefined ? {} : { sell_within_95_days: days[1] }),
          });
        },
      },
      {
        method: "GET",
        path: "/data/model/{group_id}/history",
        documentedAt: REFERENCE,
        respond(request, params) {
          const busy = gate(request);
          if (busy) return busy;
          const m = find(params.group_id);
          if (!m) return notFound();
          const n = m.weeks ?? 13;
          const weeks = Array.from({ length: n }, (_, i) => {
            const usd = m.price - (n - 1 - i) * 50;
            return {
              week: day(MONDAY - (n - i) * WEEK_MS),
              count: 30 + i,
              mean: { USD: usd, EUR: Math.round(usd * 0.9) },
              min: { USD: Math.round(usd * 0.8), EUR: Math.round(usd * 0.72) },
              max: { USD: Math.round(usd * 1.5), EUR: Math.round(usd * 1.35) },
            };
          });
          return ok({ group_id: m.group_id, weeks });
        },
      },
    ],
  });
  return {
    api,
    fetch: docMockFetch(api),
    get remaining() {
      return limit - used;
    },
  };
}

export default {
  integration: "search_the_watch_market",
  covers: "Search The Watch Market's resolve, model prices, days to sell and history",
  watchPages: [REFERENCE],
  docMocks: () => [stwmDocMock({ apiKey: "" }).api],
} satisfies DocMockModule;
