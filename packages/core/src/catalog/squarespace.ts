import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects with a Squarespace API key made with Read Only permission for Orders, Inventory and Products, which Squarespace lets each API have. The client sends only GET requests for those three lists. Custom API keys need the Commerce Advanced plan. Until a paid site is set up, the mock built from Squarespace's reference stands in",
  capabilities: [
    "Reads the whole catalog with each variant's price, sale price and stock, on every sync",
    "Reads every stock line, so on-hand counts stay current",
    "Imports five years of orders, then the orders changed since the last sync",
    "Keeps customers under keyed references, never their emails, names or addresses",
    "Read-only: updating stock and fulfilling orders are declared but turned off",
  ],
  settings: ["SQUARESPACE_API_KEY", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
