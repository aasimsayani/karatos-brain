import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  settings: ["FINCEN_8300_IMPORT_DIR"],
  note: "The store's Form 8300 filings log, kept as CSV. BSA E-Filing has no API, so a person files and KaratOS tracks what was filed",
  capabilities: [
    "Imports five years of Form 8300 filings: date filed, sales covered, cash, and the BSA Tracking ID or BSA ID",
    "Stops the Form 8300 reminder once a filing covers the sale, and raises it again if FinCEN rejects the filing",
    "Reminds the store to send the written customer statement due by January 31, never for a suspicious filing",
    "Reads only dates, sale and customer numbers, amounts and BSA numbers, never names or taxpayer numbers",
    "Read-only: filing stays with a person in BSA E-Filing, and KaratOS never changes the log",
  ],
} satisfies ConnectorCatalogEntry;
