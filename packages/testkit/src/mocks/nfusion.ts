import { fixtureBuilder } from "../fixtures.js";
import { checkDocMock, docMockFetch, type DocMock, type DocMockFetch, type DocMockModule, type DocMockRequest, type DocMockResponse } from "../doc-mock.js";

/**
 * The two spot reads of nFusion Solutions' Market Data API a read-only
 * connector uses, built from nFusion's OpenAPI spec (the apis.guru mirror).
 * Data is synthetic. nFusion has no sandbox; once a token is set up,
 * recordings replace this mock.
 *
 * Docs facts the mock relies on:
 * - Base URL https://api.nfusionsolutions.biz, every endpoint a GET with its
 *   parameters in the query string, and the token as the `token` query
 *   parameter (spec servers and securitySchemes).
 * - `GET /api/v1/Metals/spot/summary` needs `metals` and takes currency,
 *   unitofmeasure (mg, g, kg, gr, oz, toz, ct, dwt) and format (json, xml);
 *   it answers SummaryResponse[]. `GET /api/v1/Metals/spot/history` needs
 *   `metals` and `start`, and takes end, interval (an optional count and
 *   one of y, m, w, d, h, mi; 1 day by default), historicalfx and the same
 *   three; it answers IntervalCollectionResponse[]. Responses are 200, 400
 *   or 401.
 * - Each response element is {success, error, requestedSymbol,
 *   requestedCurrency, requestedUnitOfMeasure, data}. A Summary has symbol,
 *   baseCurrency, timeStamp and nullable doubles bid, ask, last, open, high,
 *   low and more; an IntervalCollection has name, symbol, baseCurrency and
 *   intervals of {start, end, open, high, low, last, change, changePercent}.
 * - A rate limit is HTTP 403 with substatus 502 (nFusion's support page).
 */
const BASE = "https://api.nfusionsolutions.biz";
export const NFUSION_SPEC_URL = "https://api.apis.guru/v2/specs/nfusionsolutions.biz/1/openapi.json";
export const NFUSION_MOCK_METALS = ["gold", "silver", "platinum", "palladium"] as const;
const UNITS = new Set(["mg", "g", "kg", "gr", "oz", "toz", "ct", "dwt"]);
const COMMON = ["currency", "unitofmeasure", "format", "token"];
const SUMMARY_QUERY = new Set(["metals", ...COMMON]);
const HISTORY_QUERY = new Set(["metals", "start", "end", "interval", "historicalfx", ...COMMON]);
const INTERVAL = /^([1-9][0-9]*)?(y|m|w|d|h|mi)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A plain IIS 403.502 page, as the mock's guess at how nFusion's rate limit reads. */
export const NFUSION_RATE_LIMIT_PAGE = "<html><body><h1>HTTP Error 403.502 - Forbidden</h1><p>Too many requests from the same client IP.</p></body></html>";

export type NfusionMockRecord = Record<string, unknown>;

/** Synthetic dollars an ounce for each metal, so tests can check the conversion. */
export const NFUSION_MOCK_PRICES: Readonly<Record<string, number>> = { gold: 2650.25, silver: 31.5, platinum: 980.1, palladium: 1012.75 };

/** Spot summary `n`: gold, quoted `n` minutes into 2026-11-11 (UTC). */
export const nfusionSummary = fixtureBuilder<NfusionMockRecord>((n) => ({
  symbol: "gold",
  baseCurrency: "USD",
  timeStamp: new Date(Date.parse("2026-11-11T00:00:00Z") + n * 60_000).toISOString(),
  bid: 2650.1,
  ask: 2651.3,
  last: 2650.7,
  open: 2640,
  high: 2655.2,
  low: 2636.4,
  oneDayChange: 10.7,
  oneDayPercentChange: 0.41,
}));

/** Daily interval `n`: day `n` of 2026 (day 1 is 2026-01-01), closing at $2,600 plus `n`. */
export const nfusionInterval = fixtureBuilder<NfusionMockRecord>((n) => {
  const start = Date.parse("2026-01-01T00:00:00Z") + (n - 1) * 86_400_000;
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString(), open: 2600, high: 2610 + n, low: 2590, last: 2600 + n, change: 1, changePercent: 0.04 };
});

/** Daily intervals for every day from `from` to `through` (YYYY-MM-DD), each closing at `price`. */
export function nfusionDays(from: string, through: string, price: number): NfusionMockRecord[] {
  const out: NfusionMockRecord[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${through}T00:00:00Z`); t += 86_400_000) {
    out.push({ start: new Date(t).toISOString(), end: new Date(t + 86_400_000).toISOString(), open: price, high: price, low: price, last: price, change: 0, changePercent: 0 });
  }
  return out;
}

export interface NfusionMockData {
  token: string;
  /** The latest summary of each metal, by name. A metal with none answers success false. */
  spot?: Readonly<Record<string, NfusionMockRecord>>;
  /** Each metal's daily intervals, by name. */
  history?: Readonly<Record<string, NfusionMockRecord[]>>;
  /** Rate-limited answers to give before the next calls. */
  rateLimits?: number;
}

export interface NfusionMock {
  mock: DocMock;
  fetch: DocMockFetch;
  /** Each read answered 200: its path and its query without the token. */
  readonly reads: { path: string; query: Record<string, string> }[];
}

const failed = (requested: string, error: string, currency: string | null, unit: string | null) => ({ success: false, error, requestedSymbol: requested, requestedCurrency: currency, requestedUnitOfMeasure: unit, data: null });
const bad = (error: string): DocMockResponse => ({ status: 400, body: { success: false, error } });
const has = <T,>(map: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

export function nfusionDocMock(data: NfusionMockData): NfusionMock {
  const reads: NfusionMock["reads"] = [];
  let limits = data.rateLimits ?? 0;

  /** Checks the token, the rate limit and the query common to both reads, then answers each requested metal. */
  function read(allowed: Set<string>, validate: (q: URLSearchParams) => string | null, answer: (metal: string, q: URLSearchParams, currency: string, unit: string) => unknown) {
    return (request: DocMockRequest): DocMockResponse => {
      const q = request.url.searchParams;
      if (q.get("token") !== data.token || !data.token) return { status: 401, text: "Unauthorized" };
      if (limits > 0) {
        limits--;
        return { status: 403, text: NFUSION_RATE_LIMIT_PAGE, headers: { "content-type": "text/html" } };
      }
      const unknown = [...q.keys()].find((k) => !allowed.has(k));
      if (unknown) return bad(`unknown parameter ${unknown}`);
      const metals = q.get("metals");
      if (!metals) return bad("metals is required");
      const unit = q.get("unitofmeasure") ?? "toz";
      if (!UNITS.has(unit)) return bad("unitofmeasure is not supported");
      const format = q.get("format") ?? "json";
      if (format !== "json" && format !== "xml") return bad("format must be json or xml");
      if (format === "xml") return bad("the mock answers only json");
      const currency = q.get("currency") ?? "USD";
      if (currency !== "USD") return bad("the mock prices only USD");
      const extra = validate(q);
      if (extra) return bad(extra);
      const query = Object.fromEntries([...q].filter(([k]) => k !== "token"));
      reads.push({ path: request.url.pathname, query });
      return { status: 200, body: metals.split(",").map((m) => answer(m.trim(), q, currency, unit)) };
    };
  }
  const summary = read(SUMMARY_QUERY, () => null, (metal, _q, currency, unit) => {
    const s = has(data.spot, metal);
    if (!s) return failed(metal, `no spot price for ${metal}`, currency, unit);
    return { success: true, error: null, requestedSymbol: metal, requestedCurrency: currency, requestedUnitOfMeasure: unit, data: s };
  });
  const validateHistory = (q: URLSearchParams): string | null => {
    const start = q.get("start");
    if (!start) return "start is required";
    // The spec types start and end as date-time; the mock takes the day form the connector sends.
    if (!DAY.test(start) || Number.isNaN(Date.parse(start))) return "start is not a date";
    const end = q.get("end");
    if (end !== null && (!DAY.test(end) || Number.isNaN(Date.parse(end)) || end < start)) return "end is not a date on or after start";
    const interval = q.get("interval") ?? "d";
    if (!INTERVAL.test(interval)) return "interval is not valid";
    if (interval !== "d" && interval !== "1d") return "the mock has only daily intervals";
    return null;
  };
  const history = read(HISTORY_QUERY, validateHistory, (metal, q, currency, unit) => {
    const intervals = has(data.history, metal);
    if (!intervals) return failed(metal, `no history for ${metal}`, currency, unit);
    const start = q.get("start")!;
    const end = q.get("end");
    const kept = intervals.filter((i) => {
      const day = String(i.start).slice(0, 10);
      return day >= start && (end === null || day <= end);
    });
    return { success: true, error: null, requestedSymbol: metal, requestedCurrency: currency, requestedUnitOfMeasure: unit, data: { name: metal[0]!.toUpperCase() + metal.slice(1), symbol: metal, baseCurrency: currency, intervals: kept } };
  });
  const mock = checkDocMock({
    integration: "nfusion",
    baseUrl: BASE,
    source: { url: NFUSION_SPEC_URL, title: "nFusion Solutions Market Data API OpenAPI spec (apis.guru mirror)", retrievedOn: "2026-11-11", version: "v1" },
    assumptions: [
      "The token is 8 to 256 letters, digits, _ or -; the docs give no format",
      "start and end take a YYYY-MM-DD day, and an interval whose day is end is still listed; the spec types them as date-time and says neither",
      "A daily interval starts at midnight UTC, and its start's date is its day",
      "The rate limit (403 with substatus 502) comes back as IIS's 403.502 page; the docs don't say how the substatus shows",
      "A wrong or missing token answers 401 with a plain-text body; the spec gives no body for it",
      "A bad query answers 400 with {success: false, error}; the spec gives no body for it",
    ],
    routes: [
      { method: "GET", path: "/api/v1/Metals/spot/summary", documentedAt: NFUSION_SPEC_URL, respond: summary },
      { method: "GET", path: "/api/v1/Metals/spot/history", documentedAt: NFUSION_SPEC_URL, respond: history },
    ],
  });
  return {
    mock,
    fetch: docMockFetch(mock),
    get reads() {
      return reads;
    },
  };
}

export default {
  integration: "nfusion",
  covers: "nFusion Solutions' Market Data API spot summary and daily spot history for gold, silver, platinum and palladium, with the token in the query string and its 403.502 rate limit",
  watchPages: [NFUSION_SPEC_URL],
  docMocks: () => [nfusionDocMock({ token: "" }).mock],
} satisfies DocMockModule;
