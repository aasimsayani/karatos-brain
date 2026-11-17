import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads an Acumatica instance's Default REST endpoint with a connected application and a KaratOS user whose role can only view stock items and sales orders. Acumatica can't limit a token to reading, so the client sends only GET requests for those two, besides signing in and out. JewelShop's memo and consignment screens aren't on the Default endpoint yet. Until a licensed instance is set up, the mock built from Acumatica's guide stands in",
  capabilities: [
    "Reads every stock item with what each warehouse has on hand, on every sync",
    "Imports five years of sales orders, then the orders changed since the last sync",
    "Keeps customers under keyed references, never their account codes or contacts",
    "Read-only: KaratOS never changes an item, an order or the books",
  ],
  settings: ["ACUMATICA_URL", "ACUMATICA_CLIENT_ID", "ACUMATICA_CLIENT_SECRET", "ACUMATICA_USERNAME", "ACUMATICA_PASSWORD", "ACUMATICA_ENDPOINT_VERSION", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
