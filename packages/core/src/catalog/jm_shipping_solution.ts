import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "partner",
  testWith: "partner",
  note: "Reads with the key and password JM issues the store (shipping@jminsure.com), and the client only ever sends GETs. JM documents no scopes, so the same key could buy labels and file claims; the connector never does. The first store's credentials confirm the mock built from JM's public API reference",
  capabilities: [
    "Imports five years of JM Shipping Solution shipments, then keeps the last 60 days current",
    "Sales sees each insured parcel's carrier, service, tracking and whether it is underinsured",
    "Finance sees each insurance claim's status and amounts, and every reconciled carrier charge",
    "Keeps no names, companies, street addresses, postal codes, phone numbers or package contents",
    "Read-only: KaratOS never buys a label, cancels a shipment, files a claim or disputes a charge",
  ],
  settings: ["JM_SHIPPING_API_KEY", "JM_SHIPPING_PASSWORD", "JM_SHIPPING_CLIENT_ID", "JM_SHIPPING_API_BASE"],
} satisfies ConnectorCatalogEntry;
