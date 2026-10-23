import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only by allowlist: Klaviyo can't be asked which scopes a private key holds, so the connector sends only listed reads and the two read-only report queries. Webhooks need Advanced KDP or a Klaviyo app",
  capabilities: [
    "Imports every profile, list, segment, campaign and flow, then keeps them current",
    "Marketing sees five years of sends, opens, clicks, conversions and revenue for each campaign and flow message",
    "Clienteling sees whether each customer agreed to email and text marketing, and which lists and segments they are in",
    "Links a Klaviyo profile to the same person's form submissions without keeping their email address, phone number, name or location",
    "Read-only: the connector only reads, and asks for a key with read-only scopes",
  ],
  settings: ["KLAVIYO_PRIVATE_API_KEY", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
