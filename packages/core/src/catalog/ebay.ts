import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects with the seller's refresh token from an app the store owns. Every access token is asked for with sell.fulfillment.readonly alone, so eBay itself turns down any change, and the only API request is getOrders. No buyer details are kept, so no eBay user data is stored",
  settings: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN", "EBAY_ENVIRONMENT"],
  historicalImportYears: 2,
  webhooks: false,
  changelog: "https://developer.ebay.com/api-docs/sell/fulfillment/release-notes.html",
  capabilities: [
    "Imports the two years of eBay orders that eBay keeps, then reads every order changed since the last sync",
    "Sales sees every eBay sale and full line refund with its SKUs, the same way as Shopify and BigCommerce sales",
    "Shows what eBay kept in fees on each order, so a piece's margin on eBay compares with the store's own",
    "Keeps no buyer username, name, email address or shipping address",
    "Setting a listing's quantity or price and adding tracking are declared but turned off, each needing approval",
  ],
} satisfies ConnectorCatalogEntry;
