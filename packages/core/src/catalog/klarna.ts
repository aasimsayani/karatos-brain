import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  note: "Reads settlements only, with an API key or username and password. Klarna keys can't be limited to settlements, so the client sends only GET requests to the payouts and settlement transactions lists. Klarna keeps no changelog for the Settlements API, so the vendor docs watch follows its reference; until a playground account is set up, the mock built from Klarna's docs stands in",
  capabilities: [
    "Imports five years of Klarna payouts, then each new one, with every sale, return, fee and commission behind it",
    "Shows what Klarna deposited under the payment reference on the bank statement, with its totals",
    "Matches each settlement line to its Klarna order, capture or refund and the store's own order reference",
    "Read-only: sends only settlement reads, so KaratOS never captures or refunds a Klarna order",
  ],
  settings: ["KLARNA_API_KEY", "KLARNA_USERNAME", "KLARNA_PASSWORD", "KLARNA_REGION", "KLARNA_ENVIRONMENT"],
} satisfies ConnectorCatalogEntry;
