import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "CSV exports of invoices and memos from any supplier, read for memo terms and System of Warranties and Kimberley Process statements",
  capabilities: [
    "Imports six years of supplier invoice and memo lines: items, quantities, costs, memo terms and due dates",
    "Follows every memo line to the date it must go back or be paid for, with the memo reminder",
    "Tells natural diamonds from lab-grown ones, and diamond-cut metal from diamonds",
    "Flags a recent invoice or memo for natural diamonds with no System of Warranties statement on it",
    "Read-only: KaratOS only reads the exports and never contacts your suppliers",
  ],
  settings: ["SUPPLIER_INVOICES_IMPORT_DIR"],
} satisfies ConnectorCatalogEntry;
