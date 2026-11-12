import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "public_api",
  testWith: "paid_account",
  webhooks: true,
  changelog: "https://www.watchtraderhub.com/docs/api/changelog",
  note: "Reads with the API key a dealer on the Business plan generates under Custom Integration, Settings. The key has no scopes and could also report or cancel orders and upsert customers, so the client only ever sends GETs. Test mode shares the live inventory, so the first dealer's account confirms the mock built from WatchTraderHub's docs",
  capabilities: [
    "Imports every published watch listing, spare part and reported order, then reads only what changed since the last sync",
    "Inventory sees each watch with its brand, stock number, price and whether it is in stock or sold",
    "Inventory sees each spare part with its maker, stock number, price and quantity on hand",
    "Sales sees each order the dealer's site reports, with its status and totals, without counting the sale twice",
    "Keeps no buyer names, emails, phones or addresses, and no descriptions or photos",
    "Read-only: KaratOS only reads your WatchTraderHub account and never reports or cancels an order",
  ],
  settings: ["WATCHTRADERHUB_API_KEY"],
} satisfies ConnectorCatalogEntry;
