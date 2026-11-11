import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the store's public service reviews and trust score with only a Trustpilot application's API key, which reaches only public endpoints and can't reply or invite; the API secret is never used. Product reviews and invitations need a business user's token, so they aren't read. API access needs Trustpilot's API module: the first client's business unit confirms the mock built from Trustpilot's docs",
  capabilities: [
    "Imports five years of the store's Trustpilot reviews, then the reviews posted in the last 30 days again on each sync, so a reply or an edit shows up",
    "Marks reviews of two stars or fewer for follow-up, and reviews the store hasn't replied to as waiting on a reply",
    "Tracks the store's trust score and its review counts by rating",
    "Shows each review's rating, excerpt, verification and reply the same way as Yext, Yotpo and Judge.me reviews, never the reviewer's name",
    "Read-only: KaratOS never replies to a review or sends an invitation",
  ],
  settings: ["TRUSTPILOT_API_KEY", "TRUSTPILOT_BUSINESS_UNIT_ID"],
} satisfies ConnectorCatalogEntry;
