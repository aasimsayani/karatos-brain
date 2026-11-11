import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads customers, points transactions and VIP tiers with a merchant API key made with read scopes only, which needs Smile's Plus or Enterprise plan. Referrals have no list in Smile's API. The first client's key confirms the mock built from Smile's docs",
  capabilities: [
    "Imports five years of loyalty customers and points transactions, then reads only what changed on each sync",
    "Shows each customer's points balance, program state, VIP tier, when it ends and how far they are from the next tier",
    "Links each loyalty customer to the same customer as forms, Klaviyo, Quo and Yotpo, without keeping the email address",
    "Keeps no names, birthdays, referral links or transaction notes",
    "Read-only: KaratOS never adds or takes away points",
  ],
  settings: ["SMILE_API_KEY", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
