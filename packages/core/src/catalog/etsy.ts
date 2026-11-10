import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Connects with the shop owner's refresh token, granted transactions_r and listings_r only. After every refresh the connector asks Etsy which scopes the token has and stops if any could change data. Etsy has no sandbox: a developer's own shop confirms the mock built from Etsy's docs",
  settings: ["ETSY_KEYSTRING", "ETSY_SHARED_SECRET", "ETSY_REFRESH_TOKEN", "ETSY_SHOP_ID"],
  changelog: "https://github.com/etsy/open-api/discussions",
  capabilities: [
    "Imports five years of Etsy orders, then reads every order changed since the last sync",
    "Sales sees every paid Etsy sale and full refund with its SKUs, the same way as eBay and Shopify sales",
    "Inventory sees every listing, in every state, with each product's price and stock on Etsy",
    "Keeps no buyer name, email address, shipping address or checkout message",
    "Changing a listing's stock or price and marking an order shipped are declared but turned off, each needing approval",
  ],
} satisfies ConnectorCatalogEntry;
