import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads with an API token given only the Tickets, Estimates and Invoices List/Search permissions, and the client sends only GET requests to those three lists. RepairShopr keeps no public API changelog, so the vendor docs watch follows its API docs instead; until a trial account is set up, the mock built from those docs stands in",
  capabilities: [
    "Imports five years of repair tickets, estimates and invoices, then what changed",
    "Follows each job from intake through its quote to the invoice and whether it was paid",
    "Keeps customers as their RepairShopr ID, never a name, email, phone or address",
    "Read-only: KaratOS never changes a ticket, estimate or invoice",
  ],
  settings: ["REPAIRSHOPR_API_TOKEN", "REPAIRSHOPR_SUBDOMAIN"],
} satisfies ConnectorCatalogEntry;
