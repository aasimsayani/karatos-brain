import type { Connector, SourceBatch, SyncContext, WriteAction } from "@karatos/core";
import { METAL_SYMBOLS, metalsApiClient, TIMESERIES_MAX_DAYS, type MetalsApiClient, type MetalsApiClientOptions, type MetalsApiRates, type PricedMetal } from "./client.js";

/**
 * Spot prices for gold, silver, platinum and palladium from Metals-API, in
 * US dollars per troy ounce, as the metals department's
 * metal.price_updated events. The historical import reads one closing price
 * a day, 30 days and one metal per request, ending yesterday (the API won't
 * give a timeseries for today). Each incremental sync reads the latest
 * prices for all four metals in one request. Metals-API only publishes
 * prices, so there is nothing to write back.
 */

/** None: Metals-API has nothing to write to. */
export const METALS_API_WRITES: WriteAction[] = [];

export const METALS = Object.keys(METAL_SYMBOLS) as PricedMetal[];

export interface MetalsApiOptions extends Pick<MetalsApiClientOptions, "accessKey" | "fetch" | "sleep" | "rateLimitRetries" | "baseUrl"> {
  /** Days of daily prices the historical import reads, ending yesterday. Each 30 days costs one request per metal. */
  historyDays?: number | undefined;
  now?: () => Date;
  /** For tests: a client already made. */
  client?: MetalsApiClient;
}

export interface MetalPriceEvent {
  id: string;
  type: "metal.price_updated";
  occurredAt: string;
  receivedAt: string;
  idempotencyKey: string;
  payload: { metal: PricedMetal; spotPerTroyOunceCents: number; quote: "daily" | "latest"; priceDate: string };
}

/** Where the historical import stands: the day it ends on, fixed at its start, and the requests already read. */
export interface MetalsApiCursor {
  through: string;
  since: string;
  next: number;
}

export const MAX_HISTORY_DAYS = 1825;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/**
 * Cents per troy ounce from a rate with base USD. `XAU` is ounces per
 * dollar, so the price is its inverse; `USDXAU`, when the API sends it, is
 * the price itself and wins. Null for anything missing, zero, negative or
 * absurd, so a bad quote is skipped rather than stored.
 */
export function centsPerOunce(rates: MetalsApiRates, symbol: string): number | null {
  const direct = rates[`USD${symbol}`];
  const inverse = rates[symbol];
  let dollars: number | null = null;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) dollars = direct;
  // A bad inverse (zero, negative, not finite) gives a price the range check below turns down.
  else if (typeof inverse === "number") dollars = 1 / inverse;
  if (dollars === null) return null;
  const cents = Math.round(dollars * 100);
  // No precious metal has traded under a cent or over a million dollars an ounce.
  return cents >= 1 && cents <= 100_000_000 ? cents : null;
}

export function parseMetalsApiCursor(raw: string | null): MetalsApiCursor | null {
  if (raw === null) return null;
  const c = JSON.parse(raw) as MetalsApiCursor;
  if (!c || typeof c.through !== "string" || !DATE.test(c.through) || typeof c.since !== "string" || !DATE.test(c.since) || c.since > c.through || !Number.isInteger(c.next) || c.next < 0) {
    throw new Error("Metals-API checkpoint is not in the expected shape");
  }
  return c;
}

/** The requests a historical import makes: each 30-day stretch from `since` to `through`, one per metal. */
export function historyRequests(since: string, through: string): { metal: PricedMetal; start: string; end: string }[] {
  const requests: { metal: PricedMetal; start: string; end: string }[] = [];
  for (let start = since; start <= through; start = addDays(start, TIMESERIES_MAX_DAYS)) {
    const last = addDays(start, TIMESERIES_MAX_DAYS - 1);
    const end = last < through ? last : through;
    for (const metal of METALS) requests.push({ metal, start, end });
  }
  return requests;
}

export function metalsApiConnector(options: MetalsApiOptions): Connector {
  const client = options.client ?? metalsApiClient(options);
  const now = options.now ?? (() => new Date());
  const historyDays = options.historyDays ?? 365;
  if (!Number.isInteger(historyDays) || historyDays < 1 || historyDays > MAX_HISTORY_DAYS) throw new Error(`historyDays must be a whole number from 1 to ${MAX_HISTORY_DAYS}`);

  const event = (metal: PricedMetal, cents: number, quote: "daily" | "latest", occurredAt: string, priceDate: string, receivedAt: string): MetalPriceEvent => {
    const key = quote === "daily" ? `${metal}:day:${priceDate}` : `${metal}:at:${occurredAt}`;
    return {
      id: `metals_api_${key.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      type: "metal.price_updated",
      occurredAt,
      receivedAt,
      idempotencyKey: `metals_api:${key}`,
      payload: { metal, spotPerTroyOunceCents: cents, quote, priceDate },
    };
  };

  async function* history(context: SyncContext): AsyncIterable<SourceBatch> {
    const saved = parseMetalsApiCursor(context.cursor);
    const through = saved?.through ?? addDays(isoDay(now()), -1);
    const since = saved?.since ?? addDays(through, -(historyDays - 1));
    const requests = historyRequests(since, through);
    for (let i = saved?.next ?? 0; i < requests.length; i++) {
      const { metal, start, end } = requests[i]!;
      const receivedAt = now().toISOString();
      const series = await client.timeseries(METAL_SYMBOLS[metal], start, end);
      const events = Object.entries(series.rates)
        .filter(([day]) => DATE.test(day) && day >= start && day <= end)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .flatMap(([day, rates]) => {
          const cents = centsPerOunce(rates, METAL_SYMBOLS[metal]);
          // A closing price stands for the end of its day.
          return cents === null ? [] : [event(metal, cents, "daily", `${day}T23:59:59.000Z`, day, receivedAt)];
        });
      const cursor: MetalsApiCursor = { through, since, next: i + 1 };
      yield { events, cursor: JSON.stringify(cursor) };
    }
  }

  async function* latest(): AsyncIterable<SourceBatch> {
    const receivedAt = now().toISOString();
    const quote = await client.latest(METALS.map((m) => METAL_SYMBOLS[m]));
    const at = new Date(quote.timestamp * 1000).toISOString();
    const events = METALS.flatMap((metal) => {
      const cents = centsPerOunce(quote.rates, METAL_SYMBOLS[metal]);
      return cents === null ? [] : [event(metal, cents, "latest", at, at.slice(0, 10), receivedAt)];
    });
    yield { events, cursor: JSON.stringify({ timestamp: quote.timestamp }) };
  }

  return {
    source: "metals_api",
    historicalImport: (context) => history(context),
    incrementalSync: () => latest(),
    writes: METALS_API_WRITES,
  };
}
