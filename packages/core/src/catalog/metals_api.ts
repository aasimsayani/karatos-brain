import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Spot prices for gold, silver, platinum and palladium in dollars per troy ounce. No public API changelog; the nightly sandbox run catches API changes",
  settings: ["METALS_API_KEY"],
  capabilities: [
    "Keeps gold, silver, platinum and palladium spot prices current, in dollars per troy ounce",
    "Imports a year of daily closing prices, or up to five, so price moves have history behind them",
    "Feeds melt values for inventory and gold bought from the public, and flags big moves in spot price",
    "Read-only: Metals-API only publishes prices, and KaratOS sends it nothing but read requests",
  ],
} satisfies ConnectorCatalogEntry;
