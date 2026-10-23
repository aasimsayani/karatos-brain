import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "A REST API key with Read permission over https; the connector sends only GET requests to five read endpoints. Sales, refunds, products and stock use the same events as Shopify, Square and Clover",
  capabilities: [
    "Imports five years of orders and refunds and the whole catalog, then keeps them current",
    "Sales sees every WooCommerce sale and return with its SKUs and how it was paid, the same way as Shopify sales",
    "Inventory sees each product and variation with its price, and the stock WooCommerce counts for it",
    "Links a customer's orders together without keeping their name, email address, phone number or address",
    "Read-only: KaratOS connects with a Read key and only ever reads from your store",
  ],
  departments: ["sales", "inventory", "clienteling", "marketing"],
  settings: [
    "WOOCOMMERCE_STORE_URL",
    "WOOCOMMERCE_CONSUMER_KEY",
    "WOOCOMMERCE_CONSUMER_SECRET",
    "CUSTOMER_REF_KEY",
  ],
} satisfies ConnectorCatalogEntry;
