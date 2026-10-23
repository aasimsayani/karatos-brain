import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connector in @karatos/connectors: orders, refunds, fulfillments, products and customers, read-only",
  capabilities: [
    "Imports five years of orders, refunds and fulfillments, then keeps them current as orders change",
    "Sales sees every online and Shopify POS sale and return, with how it was paid",
    "Inventory sees every product and variant with its price and stock on hand",
    "Clienteling sees each customer and whether they agreed to email marketing",
    "Read-only: KaratOS never changes anything in your store",
  ],
} satisfies ConnectorCatalogEntry;
