import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "CSV exports from any POS, read through a column-mapping profile",
  capabilities: [
    "Imports item lists, stock counts, customer lists and sales from any POS that exports CSV",
    "Reads each system's own column names through a mapping profile, with a generic profile built in",
    "Groups sale lines into receipts and turns negative lines into returns",
    "Picks up new and changed export files on every sync, without counting a row twice",
    "Read-only: KaratOS only reads the export files and never changes anything in your POS",
  ],
} satisfies ConnectorCatalogEntry;
