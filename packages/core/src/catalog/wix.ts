import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "A self-managed Wix app holding read permissions only; the connector checks the permissions the site granted and stops on any Manage permission, and sends only eight listed read requests. Webhooks need the app (an API key gets none). Sales, products and stock use the same events as Shopify, Square and Clover",
  capabilities: [
    "Imports five years of orders and the whole catalog, stock and contact list, then keeps them current",
    "Sales sees every Wix sale and refunded item with its SKUs, the same way as Shopify sales",
    "Inventory sees each product and variant with its price, and the stock Wix counts for it",
    "Works with both Wix Stores catalogs, the older V1 and the current V3",
    "Links a customer's orders and profile without keeping their name, email address, phone number or address",
    "Read-only: KaratOS checks its Wix app holds read permissions only and won't run otherwise",
  ],
  departments: ["sales", "inventory", "clienteling", "marketing"],
  settings: ["WIX_APP_ID", "WIX_APP_SECRET", "WIX_INSTANCE_ID", "WIX_WEBHOOK_PUBLIC_KEY", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
