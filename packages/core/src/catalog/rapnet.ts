import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the weekly Rapaport Price List for round and pear diamonds. Needs a Rapaport subscription that includes the price list; built against a mock from Rapaport's developer pages and checked live once an account is connected. Instant Inventory listings aren't copied, as Rapaport's terms forbid it",
  capabilities: [
    "Reads the Rapaport Price List for round and pear diamonds every week it is published",
    "Records which prices moved in each new list, and by how much",
    "Gives buying, appraisals and wholesale the same reference price for every stone",
    "Read-only: KaratOS only reads the price list and never lists, uploads or contacts sellers",
  ],
  settings: ["RAPNET_CLIENT_ID", "RAPNET_CLIENT_SECRET"],
  changelog: "https://raptech.rapaport.com/tech-updates/",
} satisfies ConnectorCatalogEntry;
