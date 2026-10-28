import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Reads the WhatsApp group chat exports the store already has, since TheWatchSearch publishes no API or export. A partner feed from TheWatchCloud comes later",
  settings: ["WATCHSEARCH_IMPORT_DIR", "WATCHSEARCH_DEALER_KEY"],
  capabilities: [
    "Turns the dealer WhatsApp groups the store is in into a feed of offers: brand, reference, buy or sell, price, year, condition and set",
    "Shows which references several dealers are hunting right now, and the lowest price other dealers are asking for each",
    "Reads iPhone and Android chat exports in any date style, and prices in dollars, euros, pounds, Swiss francs, Hong Kong dollars and more",
    "Keeps only the offer: dealers become keyed references, and the messages' own words are never stored",
    "Read-only: KaratOS reads the exports you save and never connects to WhatsApp or TheWatchSearch",
  ],
} satisfies ConnectorCatalogEntry;
