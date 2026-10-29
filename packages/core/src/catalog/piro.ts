import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "file",
  settings: ["PIRO_IMPORT_DIR"],
  note: "Job and casting tree reports exported as CSV. PIRO's EDI documents go through the EDI X12 connector, and its REST API is for custom integrations PIRO sets up",
  capabilities: [
    "Imports five years of PIRO manufacturing jobs: status, stage, style, order number, metal, dates and weights",
    "Stores each change to a job once, so a report exported every day keeps a history of where each job stood",
    "Records each casting tree's metal issued, metal returned and the loss between them, in grams",
    "Reads weights in grams or pennyweight from columns named for their unit, never by guessing",
    "Keeps only order numbers from jobs, never customer names",
    "Read-only: KaratOS only reads the exported reports and never changes anything in PIRO",
  ],
} satisfies ConnectorCatalogEntry;
