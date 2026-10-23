import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "CSV exports and PDF statements from any bank",
  capabilities: [
    "Imports six years of bank and credit card transactions from any bank's CSV exports or PDF statements",
    "Sorts each transaction into cash deposits, card settlements, vendor payments, payroll and fees",
    "Stores a transaction once even when overlapping exports, or a CSV export and a PDF statement, both include it",
    "Lets finance check cash sales against cash deposits",
    "Read-only: KaratOS only reads the statements and never touches your accounts",
  ],
} satisfies ConnectorCatalogEntry;
