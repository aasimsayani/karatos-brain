import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads manufacturing orders and stock with one API key. Katana's keys can't be limited to reading, so the client only ever sends GET requests to the manufacturing orders and inventory lists. The vendor docs watch follows Katana's API changelog; until a trial account is set up, the mock built from Katana's docs stands in",
  capabilities: [
    "Imports five years of manufacturing orders, then each one changed since the last sync, deleted ones as cancelled",
    "Shows each order's status, quantities, deadlines, total, material and operations cost, and whether its materials are in stock",
    "Counts stock for every product and material at each location, with what is committed, expected and short",
    "Read-only: KaratOS never creates, changes or deletes a manufacturing order",
  ],
  settings: ["KATANA_API_KEY"],
} satisfies ConnectorCatalogEntry;
