import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "A store-level API account with read-only scopes. BigCommerce can't report a token's scopes, so the connector sends only GET requests to its listed paths. Sales, refunds, products and stock use the same events as Shopify, Square and Clover",
  capabilities: [
    "Imports five years of orders, refunds, products and customers, then keeps them current",
    "Sales sees every BigCommerce sale and return with its SKUs and how it was paid, the same way as Shopify sales",
    "Inventory sees each product and variant with its price, and the stock on hand at each location",
    "Wholesale price lists come in with each variant's price and quantity tiers",
    "Links a customer's orders together without keeping their name, email address, phone number or address",
    "Read-only: KaratOS reads with GET requests only and asks for read-only scopes",
  ],
  departments: ["sales", "inventory", "clienteling", "marketing"],
  settings: ["BIGCOMMERCE_STORE_HASH", "BIGCOMMERCE_ACCESS_TOKEN", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
