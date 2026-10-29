import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "CSV exports from any refiner, and PDF statements from a refiner whose layout is in its profile",
  capabilities: [
    "Imports five years of refiner and scrap settlements: lots, metals, weights, assays, metal credited and fees",
    "Checks each lot's fine weight against its weight and assay, and flags metal credited short",
    "Compares what each lot paid per fine ounce with spot on the day it settled, so a low payable rate shows up",
    "Reads weights in grams, pennyweight or troy ounces from columns named for their unit, never by guessing",
    "Read-only: KaratOS only reads the statements and never contacts your refiner",
  ],
  settings: ["REFINER_STATEMENTS_IMPORT_DIR"],
} satisfies ConnectorCatalogEntry;
