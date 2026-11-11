import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Reads nFusion's Market Data API with a token from the nFusion dashboard; the API is GET-only market data and the client only ever sends GETs. Access needs a service agreement or a free trial and there is no sandbox: the first live token confirms the mock built from nFusion's OpenAPI spec",
  capabilities: [
    "Keeps gold, silver, platinum and palladium spot prices current from nFusion, in dollars per troy ounce",
    "Imports five years of daily closing prices, so price moves and melt values have history behind them",
    "Feeds melt values for inventory and gold bought from the public, and flags big moves in spot price",
    "Read-only: nFusion only publishes prices, and KaratOS sends it nothing but read requests",
  ],
  settings: ["NFUSION_TOKEN"],
} satisfies ConnectorCatalogEntry;
