import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads reviews with the business's Birdeye API key. Birdeye has no read-only key, so the connector only ever calls Get Reviews. No sandbox: the first client's key confirms the mock built from Birdeye's docs",
  capabilities: [
    "Imports five years of reviews from every site Birdeye gathers them from, then every new or changed review",
    "Shows each review's rating, site, an excerpt and whether the store has replied, the same way as Yext reviews",
    "Keeps no reviewer names, photos or customer records, and masks email addresses and phone numbers in review text",
    "Read-only: KaratOS never replies to a review or sends a review request",
  ],
  settings: ["BIRDEYE_API_KEY", "BIRDEYE_BUSINESS_ID"],
} satisfies ConnectorCatalogEntry;
