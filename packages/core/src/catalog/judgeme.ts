import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the shop's reviews with its domain and an API token: an OAuth token with read_reviews only, or the private token, which also writes. The client only ever sends GETs of the review list. Judge.me has no sandbox: the first client's shop confirms the mock built from Judge.me's docs",
  capabilities: [
    "Imports five years of product and store reviews, then the reviews posted or changed in the last two days on each sync",
    "Marks reviews of two stars or fewer for follow-up",
    "Shows each review's rating, product, excerpt, photos and whether the reviewer was a verified buyer, the same way as Yext and Yotpo reviews",
    "Links reviewers to their orders by a keyed reference, never a name or email address",
    "Read-only: KaratOS never replies to, publishes or hides a review",
  ],
  settings: ["JUDGEME_SHOP_DOMAIN", "JUDGEME_API_TOKEN", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
