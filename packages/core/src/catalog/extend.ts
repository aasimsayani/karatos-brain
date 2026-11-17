import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  access: "public_api",
  testWith: "partner",
  note: "Reads with an API Integration's client ID and secret from the Extend Merchant Portal. Extend documents no read-only scope, so read-only is enforced in code: after the token exchange the client only sends GETs to the contract and order searches. Extend has a demo environment, but its credentials come from a demo Merchant Portal account Extend sets up; until then the mock built from Extend's docs stands in",
  capabilities: [
    "Imports every product protection contract and order Extend holds for the store, then what changed",
    "Shows each plan's status, term, coverage dates, price and the product and order it covers",
    "Keeps no customer name, email, phone or address, only ids, amounts, dates, statuses and products",
    "Read-only: KaratOS never creates, changes or cancels a contract or an order in Extend",
  ],
  settings: ["EXTEND_CLIENT_ID", "EXTEND_CLIENT_SECRET", "EXTEND_STORE_ID", "EXTEND_ENVIRONMENT"],
} satisfies ConnectorCatalogEntry;
