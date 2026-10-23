import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only scopes only; the connector stops on a connection holding any other. The docs watch follows Xero's changelog, and the nightly run against the Demo Company catches API changes",
  capabilities: [
    "Imports six years of invoices, bills, credit notes, payments, bank transactions and manual journals, with the chart of accounts and contacts",
    "Keeps every change after that within the sync interval, including invoices and bills voided or deleted in Xero",
    "Lines invoices and bills up with the payments applied to them, so finance can see what's still owed",
    "Keeps contact names without their emails, phone numbers, addresses or tax numbers",
    "Read-only: the connection is granted read scopes only, and KaratOS stops if one could ever change your books",
  ],
} satisfies ConnectorCatalogEntry;
