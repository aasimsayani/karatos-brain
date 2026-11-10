import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads order and refund transactions and nexus regions with the business's TaxJar API token. TaxJar has no read-only token, so the client only ever sends its five GETs. No free account to test with: the first client's token confirms the mock built from TaxJar's docs",
  capabilities: [
    "Imports five years of the sales and refunds recorded in TaxJar, from each source named, then the last 31 days again on each sync",
    "Shows the sales tax, amount, shipping, state and lines by SKU of each, the same way as AvaTax transactions",
    "Lists the states and countries the business has nexus in",
    "Keeps no customer names or ship-to addresses; a customer id becomes a keyed reference",
    "Read-only: KaratOS never records, changes or deletes a TaxJar transaction",
  ],
  settings: ["TAXJAR_API_TOKEN", "TAXJAR_ENVIRONMENT", "TAXJAR_PROVIDERS", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
