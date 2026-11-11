import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads items, vendors, sales invoices and purchase invoices through Business Central's standard API v2.0, signed in service to service by a Microsoft Entra app given read-only permission sets in Business Central. Every call is a GET marked read-only. Memos, jobs and diamond records are e-Jewelry's own pages without a published API, so they wait for the first client's tenant",
  capabilities: [
    "Imports every item and vendor and five years of sales and purchase invoices, then what changed on each sync",
    "Shows each item's price, cost and units on hand next to retail and memo",
    "Reads e-Jewelry's books the same way as NetSuite, QuickBooks and Xero, so finance sees one set of invoices and bills",
    "Never keeps a customer's name, address, email or phone, only Business Central's id",
    "Read-only: KaratOS never creates or changes an e-Jewelry record",
  ],
  settings: ["EJEWELRY_TENANT_ID", "EJEWELRY_ENVIRONMENT", "EJEWELRY_COMPANY_ID", "EJEWELRY_CLIENT_ID", "EJEWELRY_CLIENT_SECRET"],
} satisfies ConnectorCatalogEntry;
