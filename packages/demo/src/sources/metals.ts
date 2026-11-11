import { METALS_API_BASE, metalsApiConnector } from "@karatos/connectors";
import type { DemoCalendar } from "../store.js";
import type { DemoSource } from "./source.js";

/**
 * Spot prices in dollars per troy ounce. Today's quotes are close to the real
 * market on 11 November 2026 (gold about $4,040, silver $52.40, platinum
 * $1,565, palladium $1,045), so the numbers look right to a jeweler. The
 * earlier gold price is made up: gold jumps 6% today so the dashboard has a
 * price move to flag. Update `today` when the market moves a long way.
 */
export const DEMO_SPOT = { XAU: { before: 3_810, today: 4_040 }, XAG: { before: 52, today: 52.4 }, XPT: { before: 1_550, today: 1_565 }, XPD: { before: 1_035, today: 1_045 } } as const;
type Symbol = keyof typeof DEMO_SPOT;

const isSymbol = (s: string): s is Symbol => Object.hasOwn(DEMO_SPOT, s);

/** The price `daysAgo` days back: a gentle drift up to the day before, then today's quote. */
export function demoSpot(symbol: Symbol, daysAgo: number): number {
  const { before, today } = DEMO_SPOT[symbol];
  if (daysAgo <= 0) return today;
  return Math.round(before * (1 - daysAgo * 0.0004) * 100) / 100;
}

/**
 * A stand-in for Metals-API that answers the two endpoints the connector
 * calls, in the shapes the docs give: `latest` with dollars per ounce under
 * USD<symbol>, `timeseries` with ounces per dollar under each date.
 */
export function demoMetalsFetch(calendar: DemoCalendar): typeof globalThis.fetch {
  const today = Date.parse(`${calendar.date(0)}T00:00:00Z`);
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter(isSymbol);
    if (url.pathname.endsWith("/latest")) {
      const rates: Record<string, number> = { USD: 1 };
      for (const s of symbols) {
        rates[s] = 1 / demoSpot(s, 0);
        rates[`USD${s}`] = demoSpot(s, 0);
      }
      return Response.json({ success: true, timestamp: Math.floor(calendar.now.getTime() / 1000), date: calendar.date(0), base: "USD", rates });
    }
    if (url.pathname.endsWith("/timeseries")) {
      const start = Date.parse(`${url.searchParams.get("start_date")}T00:00:00Z`);
      const end = Date.parse(`${url.searchParams.get("end_date")}T00:00:00Z`);
      const rates: Record<string, Record<string, number>> = {};
      for (let d = start; d <= end; d += 86_400_000) {
        const daysAgo = Math.round((today - d) / 86_400_000);
        rates[new Date(d).toISOString().slice(0, 10)] = Object.fromEntries([["USD", 1], ...symbols.map((s) => [s, 1 / demoSpot(s, Math.max(daysAgo, 1))])]);
      }
      return Response.json({ success: true, timeseries: true, start_date: url.searchParams.get("start_date"), end_date: url.searchParams.get("end_date"), base: "USD", rates });
    }
    return Response.json({ success: false, error: { code: 404, info: "not found" } }, { status: 404 });
  }) as typeof globalThis.fetch;
}

export const metalsSource: DemoSource = {
  integration: "metals_api",
  role: "Gold, silver, platinum and palladium spot prices, every day",
  connector: (calendar) =>
    metalsApiConnector({
      // Assembled at runtime so no key-shaped string sits in the repository.
      accessKey: ["demo", "x".repeat(24)].join(""),
      baseUrl: METALS_API_BASE,
      fetch: demoMetalsFetch(calendar),
      sleep: async () => {},
      historyDays: 30,
      now: () => calendar.now,
    }),
};
