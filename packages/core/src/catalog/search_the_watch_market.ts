import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Reads market prices, days to sell and 13 weeks of price history for the references the store follows, with a Business API key on a paid plan. The first client's key confirms the mock built from the vendor's API reference",
  capabilities: [
    "Gives a fair market price for each reference the store follows: listings, low, high, mean and market value",
    "Shows how many days half, and nearly all, of a reference's listings take to sell, before the store buys or prices one",
    "Keeps 13 weeks of weekly prices in every currency the market quotes, so a trade-in offer can follow the trend",
    "Stays inside the plan's daily allowance, leaving room for the vendor's own assistant access",
    "Read-only: the Business API only answers GETs, and KaratOS declares no writes",
  ],
  settings: ["STWM_API_KEY", "STWM_REFERENCES"],
} satisfies ConnectorCatalogEntry;
