import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the account's meeting history and who joined each meeting through a Server-to-Server OAuth app the account's admin makes, given only two report read scopes. The client checks each token's scopes and won't read with one that can change anything. Zoom keeps reports for paid plans only, so the first client's app confirms the mock built from Zoom's docs",
  capabilities: [
    "Imports six months of the account's past meetings, then the last two days again on each sync",
    "Shows when each meeting started and ended, how long it ran, and how many people joined",
    "Links each guest to the customer's bookings and forms by a keyed reference, never a name or email address",
    "Notes whether a meeting was recorded, shared a screen or had a summary, without reading any of them",
    "Read-only: the client won't use a token with any scope that can change Zoom",
  ],
  settings: ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
