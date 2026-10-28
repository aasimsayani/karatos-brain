import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read scopes only; the connector checks the token's scopes and stops on any other, so a full-access personal token won't do. Sales, refunds, items and stock use the same events as Shopify and the POS exports",
  capabilities: [
    "Imports five years of orders, payments and refunds from every location, then keeps them current",
    "Sales sees every Square sale and return with its SKUs and how it was paid, the same way as Shopify sales",
    "Inventory sees each catalog item and variation with its price, and the stock counted at each location",
    "Links a customer's purchases together without keeping their name, email address, phone number or address",
    "Keeps only the card brand of a card payment, never its number",
    "Read-only: KaratOS connects with read scopes only and stops if a token could change anything",
  ],
  settings: ["CUSTOMER_REF_KEY"],
  signIn: [
    ["SQUARE_APPLICATION_ID", "SQUARE_APPLICATION_SECRET", "SQUARE_REFRESH_TOKEN"],
    ["SQUARE_ACCESS_TOKEN"],
  ],
} satisfies ConnectorCatalogEntry;
