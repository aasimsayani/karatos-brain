import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads the store's reviews with its store ID and API secret, and its Loyalty members' points with the Loyalty GUID and API key when given. Neither can be limited to reading, so the client only ever sends a token request and two GETs. Yotpo has no sandbox: the first client's store confirms the mock built from Yotpo's docs",
  capabilities: [
    "Imports five years of product and store reviews, then the reviews changed in the last two days on each sync",
    "Shows each review's rating, product, excerpt, sentiment and whether it was verified or incentivized, the same way as Yext and Birdeye reviews",
    "Shows each Loyalty member's points balance, points earned, perks redeemed, VIP tier and spend",
    "Links reviewers and members to their bookings and orders by a keyed reference, never a name or email address",
    "Read-only: KaratOS never replies to a review or changes a member's points",
  ],
  settings: ["YOTPO_STORE_ID", "YOTPO_API_SECRET", "YOTPO_LOYALTY_GUID", "YOTPO_LOYALTY_API_KEY", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
