import type { PricedMetal } from "../metals_api/client.js";
import { WHATNOT_USER_AGENT } from "../whatnot/client.js";

/**
 * A small client for nFusion Solutions' Market Data API (metals and
 * currencies). The API is GET-only market data, so read-only holds by
 * nature; the client also sends only GETs, to the two spot reads the
 * connector needs, with query strings it builds itself.
 *
 * nFusion takes its token as the `token` query parameter. So a request URL
 * is never put in an error, a log or a thrown error's cause, and any text
 * nFusion sends back has the token, any `token=` pair and any URL masked
 * before it is quoted.
 *
 * nFusion asks for fewer than one call a second per service, so requests
 * are spaced at least 1.1 seconds apart. A rate limit comes back as HTTP 403
 * with substatus 502: that 403, like a 429 or 5xx, is waited out and retried
 * before the error goes to runSync. Any other 401 or 403 is a token problem.
 */

export const NFUSION_API_BASE = "https://api.nfusionsolutions.biz";
/** The same User-Agent the other connectors send. */
export const NFUSION_USER_AGENT = WHATNOT_USER_AGENT;
export const NFUSION_SUMMARY_PATH = "/api/v1/Metals/spot/summary";
export const NFUSION_HISTORY_PATH = "/api/v1/Metals/spot/history";
/** The least time between two requests: nFusion asks for under one call a second per service. */
export const NFUSION_MIN_INTERVAL_MS = 1100;

/**
 * nFusion's docs don't give the token's format, so any 8 to 256 letters,
 * digits, `_` or `-` are accepted. This is a guess to check against a real
 * token: it only keeps out spaces, `&`, `=` and the like that would change
 * the query string.
 */
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WAIT_S = 60;
const RETRIED = new Set([429, 500, 502, 503, 504]);
const METAL_NAMES = new Set<string>(["gold", "silver", "platinum", "palladium"]);

export interface NfusionClientOptions {
  /** The API token from the nFusion dashboard. It is never logged or shown. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before a retry, or to space requests out; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a rate limit or 5xx is retried here before the error goes to runSync. */
  retries?: number;
  /** Milliseconds now, for spacing requests; replaced in tests. */
  clock?: () => number;
}

export class NfusionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NfusionConfigError";
  }
}

/** nFusion answered with an error, or couldn't be reached (status 0). `rateLimited` is true for its 403 with substatus 502. */
export class NfusionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = "NfusionApiError";
  }
}

export interface NfusionClient {
  /** The latest spot summary for each metal, one response element each, in USD per troy ounce. */
  spotSummary(metals: readonly PricedMetal[]): Promise<unknown[]>;
  /** Daily spot history from `start` to `end` (YYYY-MM-DD), one response element per metal, in USD per troy ounce. */
  spotHistory(metals: readonly PricedMetal[], start: string, end: string): Promise<unknown[]>;
}

const isDay = (value: string) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * Whether a 403 is nFusion's rate limit. nFusion says only "HTTP 403 with
 * substatus 502", not how the substatus reaches the client. The API is
 * served by IIS, whose 403.502 page says "403.502"; a header or body that
 * names a substatus of 502 counts too.
 */
export function isNfusionRateLimit(status: number, headers: Headers, text: string): boolean {
  if (status !== 403) return false;
  if (/\b403\.502\b/.test(text) || /sub-?status\W{0,20}502\b/i.test(text)) return true;
  for (const [name, value] of headers) if (/sub-?status/i.test(name) && value.trim() === "502") return true;
  return false;
}

export function nfusionClient(options: NfusionClientOptions): NfusionClient {
  const token = options.token?.trim() ?? "";
  if (!TOKEN.test(token)) throw new NfusionConfigError("set NFUSION_TOKEN to the API token from the nFusion dashboard (Connections, then API Keys): 8 to 256 letters, digits, _ or -");
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retries = options.retries ?? 3;
  const clock = options.clock ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;

  /** nFusion's own words, with the token masked and cut short. Never the URL. */
  const quote = (said: string) => {
    const clean = said.split(token).join("[token]").replace(/https?:\/\/\S+/gi, "[url]").replace(/token\s*=\s*["']?[^&\s"']*["']?/gi, "token=[token]").replace(/\s+/g, " ").trim().slice(0, 200);
    return clean ? `: ${clean}` : "";
  };
  const said = (body: unknown, text: string): string => {
    const first = Array.isArray(body) ? body[0] : body;
    const b = (typeof first === "object" && first !== null ? first : {}) as { error?: unknown; message?: unknown; title?: unknown };
    for (const v of [b.error, b.message, b.title]) if (typeof v === "string" && v.trim()) return v;
    return body === null && !/^\s*</.test(text) ? text : "";
  };

  async function get(path: string, what: string, params: Record<string, string>): Promise<unknown[]> {
    const query = new URLSearchParams({ ...params, currency: "USD", unitofmeasure: "toz", format: "json", token });
    const url = `${NFUSION_API_BASE}${path}?${query}`;
    for (let attempt = 0; ; attempt++) {
      const wait = last + NFUSION_MIN_INTERVAL_MS - clock();
      if (wait > 0) await sleep(wait);
      last = clock();
      let response: Response;
      try {
        // GET only, with no body: there is nothing to write in nFusion.
        response = await doFetch(url, { method: "GET", headers: { accept: "application/json", "user-agent": NFUSION_USER_AGENT } });
      } catch {
        // The fetch error can name the URL, and the URL holds the token, so it is dropped.
        throw new NfusionApiError(`could not reach nFusion for the ${what}`, 0);
      }
      const text = await response.text().catch(() => "");
      const limited = isNfusionRateLimit(response.status, response.headers, text);
      if ((RETRIED.has(response.status) || limited) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isSafeInteger(after) && after > 0 ? Math.min(after, MAX_WAIT_S) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (limited) throw new NfusionApiError(`nFusion kept answering the ${what} with its rate limit (HTTP 403, substatus 502)`, 403, true);
      if (response.status === 401 || response.status === 403) {
        throw new NfusionConfigError(`nFusion turned down the token (HTTP ${response.status})${quote(said(body, text))}; NFUSION_TOKEN must be an API token from the nFusion dashboard (Connections, then API Keys)`);
      }
      if (response.status !== 200) throw new NfusionApiError(`nFusion answered HTTP ${response.status} for the ${what}${quote(said(body, text))}`, response.status);
      if (!Array.isArray(body)) throw new NfusionApiError(`nFusion answered the ${what} without a list that reads`, 200);
      return body;
    }
  }

  const checkMetals = (metals: readonly string[]) => {
    if (metals.length === 0 || !metals.every((m) => METAL_NAMES.has(m)) || new Set(metals).size !== metals.length) {
      throw new NfusionApiError("nFusion is asked only for gold, silver, platinum and palladium here, each once", 0);
    }
  };

  return {
    async spotSummary(metals) {
      checkMetals(metals);
      return get(NFUSION_SUMMARY_PATH, "spot summary", { metals: metals.join(",") });
    },
    async spotHistory(metals, start, end) {
      checkMetals(metals);
      if (!isDay(start) || !isDay(end) || start > end) throw new NfusionApiError("spot history dates must be YYYY-MM-DD, start no later than end", 0);
      return get(NFUSION_HISTORY_PATH, "spot history", { metals: metals.join(","), start, end, interval: "1d" });
    },
  };
}
