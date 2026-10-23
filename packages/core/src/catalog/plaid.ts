import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Bank feeds beyond Chase: accounts, balances and transactions from one linked bank, read-only",
  capabilities: [
    "Imports up to two years of bank and card transactions from a bank linked through Plaid",
    "Keeps every new, changed and removed transaction after that within the sync interval",
    "Reads each account's current and available balance on every sync",
    "Feeds finance the same transactions a bank statement would, so cash deposits are checked either way",
    "Read-only: keeps no account numbers or owner details, and never moves money or changes the link",
  ],
} satisfies ConnectorCatalogEntry;
