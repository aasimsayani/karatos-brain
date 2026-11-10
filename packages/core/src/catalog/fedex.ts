import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "sandbox",
  webhooks: false,
  note: "Reads FedEx tracking for each number on the business's list until the package is delivered or returned, with FedEx's free Track API. FedEx's sandbox checks the sign-in and calls; the docs watch follows FedEx's announcements, and the nightly sandbox run catches API changes",
  capabilities: [
    "Follows every FedEx package on the business's list, from label created to delivered or returned",
    "Flags a delivery exception, such as a damaged parcel or a refused delivery, as soon as FedEx records it",
    "Shows which parcels needed a direct or adult signature, for insured jewelry shipments",
    "Gives the expected delivery day and the delivered day, for repairs, memo goods and customer orders",
    "Read-only: KaratOS only reads tracking, never creates labels, and keeps no names, addresses or signatures",
  ],
  settings: ["FEDEX_CLIENT_ID", "FEDEX_CLIENT_SECRET", "FEDEX_TRACKING_NUMBERS_FILE"],
  changelog: "https://developer.fedex.com/api/en-us/announcements.html",
} satisfies ConnectorCatalogEntry;
