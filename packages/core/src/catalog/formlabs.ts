import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads with a Formlabs Developer API client ID and secret. A token can't be limited to reading, so the client asks only for a token and lists print runs. The API needs a Formlabs account with a printer registered to Dashboard; until one is set up, the mock built from the published reference stands in",
  capabilities: [
    "Imports a year of print runs, then the runs made in the last few days on each sync",
    "Follows each run from the queue to finished or failed, with its printer, resin, volume and layers",
    "Never keeps a print's name, who sent it, notes, part names or photos",
    "Read-only: KaratOS never changes a printer or its groups",
  ],
  settings: ["FORMLABS_CLIENT_ID", "FORMLABS_CLIENT_SECRET"],
} satisfies ConnectorCatalogEntry;
