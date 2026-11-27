import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "CSV exports from any POS, read through a column-mapping profile",
  departments: ["sales", "inventory", "clienteling", "marketing", "repairs", "bench"],
  capabilities: [
    "Imports item lists, stock counts, customer lists and sales from any POS that exports CSV",
    "Reads each system's own column names through a mapping profile, with a generic profile built in",
    "Groups sale lines into receipts and turns negative lines into returns",
    "Reads repair tickets and their status, so a late repair or one never picked up is raised before the customer calls",
    "Reads bench job stages with the jeweler, metal in and out and bench minutes, to raise late work, metal loss and labor cost",
    "Picks up new and changed export files on every sync, without counting a row twice",
    "Read-only: KaratOS only reads the export files and never changes anything in your POS",
  ],
} satisfies ConnectorCatalogEntry;
