import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  note: "Reads UPS tracking for each number on the business's list until the package is delivered or returned, with UPS's free Tracking API. UPS's test environment checks the sign-in and calls; the docs watch follows UPS's published API files, and the nightly sandbox run catches API changes",
  capabilities: [
    "Follows every UPS package on the business's list, from label created to delivered or returned",
    "Flags a delivery exception, such as a damaged parcel or a missed signature, as soon as UPS records it",
    "Shows which parcels needed a signature and which went UPS Premier, for insured jewelry shipments",
    "Gives the expected delivery day and the delivered day, for repairs, memo goods and customer orders",
    "Read-only: KaratOS only reads tracking, never creates labels, and keeps no names, addresses or signatures",
  ],
  settings: ["UPS_CLIENT_ID", "UPS_CLIENT_SECRET", "UPS_TRACKING_NUMBERS_FILE"],
  changelog: "https://github.com/UPS-API/api-documentation/commits/main",
} satisfies ConnectorCatalogEntry;
