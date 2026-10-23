import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only, though Intuit has no read-only scope. Intuit's changelog (release notes) page needs JavaScript, so the docs watch reads the pages the mock was built from instead, and the nightly sandbox run catches API changes",
  capabilities: [
    "Imports six years of invoices, bills, payments and journal entries, with the chart of accounts, customers and vendors",
    "Keeps every change after that within the sync interval, and notices records deleted in QuickBooks",
    "Lines invoices up with the payments applied to them, so finance can see what's still owed",
    "Keeps customer and vendor names without their emails, phone numbers, addresses or tax IDs",
    "Read-only: KaratOS only reads your books, even though QuickBooks' connection would allow changes",
  ],
} satisfies ConnectorCatalogEntry;
