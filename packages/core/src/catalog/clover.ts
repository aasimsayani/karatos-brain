import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connector in @karatos/connectors: orders, payments, refunds, items, stock and customers, read-only. Clover can't report an app's permissions, so the connector sends only its listed GET requests",
  capabilities: [
    "Imports five years of Clover orders, payments and refunds, then keeps them current as they change",
    "Sales sees every counter sale and return with its lines and how it was paid, in the same shape as Shopify",
    "Inventory sees every item with its price and cost, and the stock on hand each day",
    "Clienteling sees each customer as a private reference with their marketing choice, never their name or contact details",
    "Read-only: KaratOS only reads from Clover and never changes stock, items or orders",
  ],
  settings: ["CLOVER_MERCHANT_ID", "CLOVER_REGION", "CUSTOMER_REF_KEY"],
  signIn: [
    ["CLOVER_APP_ID", "CLOVER_APP_SECRET", "CLOVER_REFRESH_TOKEN"],
    ["CLOVER_API_TOKEN"],
  ],
} satisfies ConnectorCatalogEntry;
