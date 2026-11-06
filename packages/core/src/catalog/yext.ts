import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects with an API key of a Yext app the store owns, which should hold read access to Entities and Reviews only. Its only API requests are two GETs, the location list and the review list. Listing status and analytics are a follow-up. No public API changelog found; the docs watch follows the three doc pages the mock was built from",
  settings: ["YEXT_API_KEY", "YEXT_ACCOUNT_ID", "YEXT_ENVIRONMENT"],
  capabilities: [
    "Imports two years of reviews from Google, Yelp, Facebook and the other sites Yext watches, with the rating, an excerpt and where to answer it",
    "Flags every review the store hasn't replied to yet, so none goes unanswered",
    "Reads each location's name, address, time zone and whether it is closed",
    "Keeps no reviewer name or email, and masks email addresses and phone numbers in what a review says",
    "Replying to a review and changing a location's hours are declared but turned off, and would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
