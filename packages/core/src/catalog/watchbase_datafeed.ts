import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "public_api",
  testWith: "paid_account",
  note: "Reads with the API key of a self-serve WatchBase datafeed account, paid in credits at US$0.25 a watch read, and the client only ever sends GETs. WatchBase has no sandbox: the first account's key confirms the mock built from WatchBase's datafeed manual",
  capabilities: [
    "Reads the reference specs of every watch of the brands the store deals in, from WatchBase",
    "Inventory and sales see each reference's caliber, case, dial, water resistance and release year",
    "Later syncs read only the watches WatchBase added or changed since the brand was last read",
    "Caps the watch reads a sync makes, so DataFeed credits are spent only as far as the store allows",
    "Read-only: WatchBase only gives data, and KaratOS sends it nothing but read requests",
  ],
  settings: ["WATCHBASE_API_KEY", "WATCHBASE_BRANDS", "WATCHBASE_MAX_WATCHES"],
} satisfies ConnectorCatalogEntry;
