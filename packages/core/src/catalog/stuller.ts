import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the invoices on the business's Stuller account and Stuller's metal market rates, with a developer login. Needs a Stuller account owner to make the login; built against a mock from Stuller's API help pages and checked live once a login is connected",
  capabilities: [
    "Reads every Stuller invoice from the last five years, with its lines, totals, status and tracking number",
    "Records each invoice again when its status or tracking changes, so shipments can be followed",
    "Keeps the metal rates each invoice was priced at, and Stuller's current rates for gold, silver, platinum and palladium",
    "Read-only: KaratOS only reads invoices and rates and never places an order",
  ],
  settings: ["STULLER_USERNAME", "STULLER_PASSWORD"],
  changelog: "https://api.stuller.com/help",
} satisfies ConnectorCatalogEntry;
