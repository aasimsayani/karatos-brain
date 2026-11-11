import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  note: "Reads company card transactions with an app's client credentials and the transactions:read scope only, turning down a token granted anything more. The vendor docs watch follows Ramp's API changelog; until a Ramp sandbox is set up, the mock built from Ramp's docs stands in",
  capabilities: [
    "Imports five years of company card transactions, then each one Ramp says changed since the last sync",
    "Shows each purchase's amount, merchant, spend category, GL account, receipt and approval state for month-end",
    "Keeps cardholders as their Ramp user ID with department and location, never a name, memo text or receipt file",
    "Read-only: the app is given no write scope, so KaratOS never adds a memo or codes a transaction",
  ],
  settings: ["RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET", "RAMP_ENVIRONMENT"],
} satisfies ConnectorCatalogEntry;
