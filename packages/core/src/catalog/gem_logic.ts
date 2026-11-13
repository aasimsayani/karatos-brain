import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads with an API key from Settings > API. Gem Logic keys can't be limited to reading, so the client sends only GET requests to the sales channels and their products. Gem Logic keeps no public API changelog, so the vendor docs watch follows its API docs instead; until a trial instance is set up, the mock built from those docs stands in",
  capabilities: [
    "Imports every product on each sales channel, then reads them again on each sync so a new status shows",
    "Keeps each product's SKU, status, channel, image count, weight and size",
    "Read-only: KaratOS never changes a product, sale or repair",
  ],
  settings: ["GEM_LOGIC_API_KEY", "GEM_LOGIC_INSTANCE"],
} satisfies ConnectorCatalogEntry;
