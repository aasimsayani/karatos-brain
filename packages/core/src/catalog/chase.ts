import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "CSV activity downloads, PDF statements or both, read with Chase's own layouts",
  capabilities: [
    "Imports six years of Chase business checking, savings and credit card activity from CSV downloads, PDF statements or both",
    "Reads Chase's own statement layout, including checks paid by number, deposits, card and electronic withdrawals, and fees",
    "Stores a transaction once even when a CSV download and a PDF statement both include it",
    "Sorts each transaction into cash deposits, card settlements, vendor payments, payroll and fees for finance",
    "Read-only: KaratOS only reads the statements you download and never connects to your Chase account",
  ],
} satisfies ConnectorCatalogEntry;
