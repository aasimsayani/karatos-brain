import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the business's IDEX Onsite feed, the network diamonds it offers on its own website with its filters and markups, and records what was listed, repriced or sold. Needs an IDEX trading subscription with the Onsite add-on; built against a mock from IDEX's API pages and checked live once a key is connected",
  capabilities: [
    "Reads the diamonds the business offers from the IDEX network, with grades, measurements and its own asking prices",
    "Records each stone that is newly listed, repriced or regraded, and each one that leaves the feed",
    "Reads the lab-grown feed too when the business has IDEX's lab-grown add-on",
    "Read-only: KaratOS only reads the feed and never lists stones or contacts suppliers",
  ],
  settings: ["IDEX_API_KEY", "IDEX_API_SECRET"],
  changelog: "https://api.idexonline.com/Onsite",
} satisfies ConnectorCatalogEntry;
