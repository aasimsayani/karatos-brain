import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  settings: ["RFID_COUNTS_IMPORT_DIR"],
  note: "Count exports from RFID readers and barcode scanners, saved as CSV, one row per tag",
  capabilities: [
    "Imports two years of tray and case counts: what was read, when, and by whom",
    "Flags a tray whose latest count came up short, naming the missing tags and their cost where KaratOS knows the SKU",
    "Points out pieces read in the wrong tray",
    "Counts a tag once however many times the reader picked it up, and reads the same export twice without counting it twice",
    "Read-only: KaratOS only reads the export files and never changes anything in the reader software",
  ],
} satisfies ConnectorCatalogEntry;
