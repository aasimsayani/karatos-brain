import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "partner",
  note: "Reads the diamonds a saved Nivoda search finds, with grades, measurements and prices, and records what was listed, repriced or sold. Needs a Nivoda buyer account with API access, which Nivoda turns on by request; built against a mock from Nivoda's API help pages and checked on Nivoda's staging API first",
  capabilities: [
    "Reads the diamonds a saved Nivoda search finds, with grades, measurements and prices",
    "Records each diamond that is newly listed, repriced or regraded, and each one that leaves the search",
    "Spaces its requests 30 seconds apart, as Nivoda asks, and never marks stones sold on a partial read",
    "Read-only: KaratOS only searches and never holds or orders a diamond",
  ],
  settings: ["NIVODA_USERNAME", "NIVODA_PASSWORD"],
  changelog: null,
} satisfies ConnectorCatalogEntry;
