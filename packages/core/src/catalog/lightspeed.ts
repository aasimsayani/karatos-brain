import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  webhooks: false,
  note: "Lightspeed Retail X-Series (formerly Vend), not R-Series. Read scopes only; the connector checks the scopes Lightspeed reports on every token and stops on any other. Sales, products, stock and customers use the same events as Square and Shopify",
  capabilities: [
    "Imports five years of sales and returns from every outlet, with every product, stock level and customer, then keeps them current",
    "Sales sees every Lightspeed sale and return with its SKUs and how it was paid, the same way as Square and Shopify sales",
    "Inventory sees each product with its price, and the stock on hand at each outlet",
    "Links a customer's purchases together without keeping their name, email address, phone number, birthday or address",
    "Read-only: KaratOS connects with read scopes only and stops if the connection could change anything",
  ],
  settings: ["LIGHTSPEED_DOMAIN_PREFIX", "LIGHTSPEED_CLIENT_ID", "LIGHTSPEED_CLIENT_SECRET", "LIGHTSPEED_REFRESH_TOKEN", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
