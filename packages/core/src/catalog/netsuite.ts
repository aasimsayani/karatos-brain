import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads items, vendors, sales and purchase orders, invoices, journal entries and stock by location with SuiteQL, signed in by OAuth 2.0 machine-to-machine with a certificate mapped to a role that can only view. The token asks only for the rest_webservices scope, and every query is a fixed SELECT. The first client's account confirms the mock built from NetSuite's docs",
  capabilities: [
    "Imports every item and vendor and six years of orders, invoices and journal entries, then what changed on each sync",
    "Shows stock on hand, available, committed and on order for each item at each location",
    "Reads NetSuite's books the same way as QuickBooks and Xero, so finance sees one set of invoices and journal entries",
    "Never keeps a vendor's name when the vendor is a person",
    "Read-only: KaratOS never creates or changes a NetSuite record",
  ],
  settings: ["NETSUITE_ACCOUNT_ID", "NETSUITE_CLIENT_ID", "NETSUITE_CERTIFICATE_ID", "NETSUITE_PRIVATE_KEY"],
} satisfies ConnectorCatalogEntry;
