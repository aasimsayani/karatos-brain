import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "partner",
  note: "Reads the account's locations, their Google reviews and their daily views, calls, direction requests and website clicks. Google offers only the business.manage scope for these APIs, so the connection holds that scope alone and the client sends only GETs to three fixed paths. Google approves Business Profile API access per project on request",
  capabilities: [
    "Imports two years of Google reviews for every location, then the new and edited ones on each sync",
    "Marks reviews of two stars or fewer for follow-up and shows which still wait on a reply",
    "Shows each location's daily Maps and Search views, calls, direction requests and website clicks",
    "Never keeps a reviewer's name or photo, and masks emails and phone numbers in review text",
    "Read-only: KaratOS never replies to a review or changes a listing",
  ],
  settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN", "GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID"],
} satisfies ConnectorCatalogEntry;
