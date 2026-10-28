/**
 * A small client for Metals-API (metals-api.com). Read-only by nature: the
 * API only publishes prices, and the client only sends GET requests to the
 * three reads the connector needs. Metals-API takes its key as the
 * `access_key` query parameter, so request URLs are never put in errors or
 * logs.
 */

export const METALS_API_BASE = "https://metals-api.com/api";

/** The reads the connector sends, and nothing else. */
export type MetalsApiRead = "latest" | "historical" | "timeseries";

/** Metals-API's codes for the metals the brain prices. */
export const METAL_SYMBOLS = { gold: "XAU", silver: "XAG", platinum: "XPT", palladium: "XPD" } as const;
export type PricedMetal = keyof typeof METAL_SYMBOLS;
export type MetalSymbol = (typeof METAL_SYMBOLS)[PricedMetal];

const KEY = /^[A-Za-z0-9]{20,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOLS = new Set<string>(Object.values(METAL_SYMBOLS));
/** The longest stretch one timeseries request covers. */
export const TIMESERIES_MAX_DAYS = 30;

export interface MetalsApiClientOptions {
  accessKey: string;
  fetch?: typeof globalThis.fetch;
  /** Waits before retrying a rate-limited request; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
  baseUrl?: string;
}

export class MetalsApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetalsApiConfigError";
  }
}

/** Metals-API answered with an error, as an HTTP status or as `success: false`. */
export class MetalsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "MetalsApiError";
  }
}

/** Rates as Metals-API sends them: with base USD, `XAU` is troy ounces per dollar and `USDXAU` dollars per ounce. */
export type MetalsApiRates = Record<string, number>;

export interface MetalsApiLatest {
  timestamp: number;
  date: string;
  base: string;
  rates: MetalsApiRates;
}

export interface MetalsApiTimeseries {
  base: string;
  /** By day, YYYY-MM-DD. */
  rates: Record<string, MetalsApiRates>;
}

export interface MetalsApiClient {
  latest(symbols: readonly MetalSymbol[]): Promise<MetalsApiLatest>;
  timeseries(symbol: MetalSymbol, startDate: string, endDate: string): Promise<MetalsApiTimeseries>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function metalsApiClient(options: MetalsApiClientOptions): MetalsApiClient {
  const key = options.accessKey?.trim() ?? "";
  if (!KEY.test(key)) throw new MetalsApiConfigError("METALS_API_KEY must be the access key from the Metals-API dashboard: letters and digits only");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? 3;
  const base = options.baseUrl ?? METALS_API_BASE;

  const checkSymbols = (symbols: readonly string[]) => {
    if (symbols.length === 0 || !symbols.every((s) => SYMBOLS.has(s))) throw new MetalsApiConfigError("Metals-API reads only XAU, XAG, XPT and XPD here");
  };

  async function get<T>(read: MetalsApiRead, path: string, params: Record<string, string>): Promise<T & { base: string }> {
    const query = new URLSearchParams({ access_key: key, base: "USD", ...params });
    const url = `${base}/${path}?${query}`;
    for (let attempt = 0; ; attempt++) {
      // GET only, with no body: there is nothing to write in Metals-API.
      const response = await doFetch(url, { method: "GET", headers: { accept: "application/json" } });
      if (response.status === 429 && attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = (await response.json().catch(() => null)) as (T & { success?: boolean; base?: string; error?: { code?: number; info?: string; type?: string } }) | null;
      // Errors name the read, never the URL: it holds the key.
      if (!response.ok || !body || body.success === false) {
        const info = body?.error?.info ?? body?.error?.type;
        throw new MetalsApiError(`Metals-API answered ${read} with ${response.ok ? "an error" : `HTTP ${response.status}`}${info ? `: ${info.replaceAll(key, "[key]").slice(0, 200)}` : ""}`, response.status, body?.error?.code);
      }
      if (body.base !== "USD") throw new MetalsApiError(`Metals-API answered ${read} in ${String(body.base)}, not USD`, response.status);
      return body as T & { base: string };
    }
  }

  return {
    async latest(symbols) {
      checkSymbols(symbols);
      const body = await get<MetalsApiLatest>("latest", "latest", { symbols: symbols.join(",") });
      if (!Number.isInteger(body.timestamp) || typeof body.rates !== "object" || body.rates === null) throw new MetalsApiError("Metals-API latest did not answer with rates", 200);
      return body;
    },
    async timeseries(symbol, startDate, endDate) {
      checkSymbols([symbol]);
      if (!DATE.test(startDate) || !DATE.test(endDate)) throw new MetalsApiConfigError("timeseries dates must be YYYY-MM-DD");
      const span = days(startDate, endDate);
      if (span < 0 || span >= TIMESERIES_MAX_DAYS) throw new MetalsApiConfigError(`a timeseries read covers 1 to ${TIMESERIES_MAX_DAYS} days`);
      const body = await get<MetalsApiTimeseries>("timeseries", "timeseries", { symbols: symbol, start_date: startDate, end_date: endDate });
      if (typeof body.rates !== "object" || body.rates === null) throw new MetalsApiError("Metals-API timeseries did not answer with rates", 200);
      return body;
    },
  };
}
