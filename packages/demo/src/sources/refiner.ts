import { memoryFileSource, refinerStatementsConnector } from "@karatos/connectors";
import type { DemoCalendar } from "../store.js";
import { demoSpot } from "./metals.js";
import { csvLine, dollarsText, type DemoSource } from "./source.js";

const DWT_PER_OZT = 20;

interface DemoLot {
  lot: string;
  daysAgo: number;
  description: string;
  grossDwt: number;
  /** Fineness the assay found, as a fraction. */
  assay: number;
  /** Fine weight the refiner credited. */
  fineDwt: number;
  /** Share of spot the refiner paid. */
  payable: number;
  feeCents: number;
}

/**
 * Scrap gold the store sent to its refiner: old stock, broken chains and
 * what it bought over the counter.
 * - Lot DR-2207 credits about 10 dwt less fine gold than its own assay works out to.
 * - Lot DR-2214 paid 84% of spot when the usual rate is in the mid 90s.
 * - The earlier lots settled fairly, so they say nothing.
 */
export const DEMO_REFINER_LOTS: DemoLot[] = [
  { lot: "DR-2188", daysAgo: 75, description: "14K scrap, mixed", grossDwt: 310, assay: 0.583, fineDwt: 180.73, payable: 0.96, feeCents: 18_500 },
  { lot: "DR-2196", daysAgo: 46, description: "18K scrap, old stock", grossDwt: 142, assay: 0.75, fineDwt: 106.5, payable: 0.96, feeCents: 12_000 },
  { lot: "DR-2207", daysAgo: 20, description: "14K buy-from-public", grossDwt: 268, assay: 0.583, fineDwt: 146.4, payable: 0.95, feeCents: 16_500 },
  { lot: "DR-2214", daysAgo: 6, description: "10K and 14K chains", grossDwt: 225, assay: 0.5, fineDwt: 112.5, payable: 0.84, feeCents: 15_000 },
];

export function refinerExports(calendar: DemoCalendar): Record<string, string> {
  const rows = ["Settlement Date,Lot,Metal,Description,Gross DWT,Assay,Fine DWT,Price per Oz,Credit,Fee,Net"];
  for (const l of DEMO_REFINER_LOTS) {
    const spot = demoSpot("XAU", l.daysAgo);
    const price = Math.round(spot * l.payable * 100);
    const credit = Math.round((l.fineDwt / DWT_PER_OZT) * price);
    rows.push(csvLine([calendar.usDate(l.daysAgo), l.lot, "Gold", l.description, l.grossDwt.toFixed(2), `${(l.assay * 100).toFixed(1)}%`, l.fineDwt.toFixed(2), dollarsText(price), dollarsText(credit), dollarsText(l.feeCents), dollarsText(credit - l.feeCents)]));
  }
  return { "settlements.csv": rows.join("\n") };
}

export const refinerSource: DemoSource = {
  integration: "refiner_statements",
  role: "The refiner's settlement statements for scrap gold sent in",
  connector: (calendar) =>
    refinerStatementsConnector({ refiners: [{ id: "demo_refining_co", source: memoryFileSource(refinerExports(calendar), calendar.at(0, 6)) }], now: () => calendar.now }),
};
