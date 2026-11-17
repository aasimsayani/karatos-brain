import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "public_api",
  testWith: "paid_account",
  note: "Reads with a seller API token the account owner creates in Whatnot's developer dashboard with only read:orders and read:inventory, and the client only ever sends GETs. Whatnot's REST API has no sandbox: the first seller's account confirms the mock built from Whatnot's docs",
  capabilities: [
    "Imports every Whatnot order and product, then keeps the last 60 days of orders and every product current",
    "Sales sees each live-show and marketplace sale with its SKUs, and each cancellation nets it back out",
    "Inventory sees every product's variants with their price and the stock available on Whatnot",
    "Keeps no buyer ids, usernames or display names, and no item descriptions",
    "Read-only: KaratOS only reads your Whatnot account and never cancels an order or changes stock",
  ],
  settings: ["WHATNOT_ACCESS_TOKEN"],
} satisfies ConnectorCatalogEntry;
