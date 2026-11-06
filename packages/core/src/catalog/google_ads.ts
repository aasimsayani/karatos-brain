import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Google Ads has one scope, which can change campaigns, so the client keeps the connection read-only: its only API request is googleAds:search for the one account in the settings, built from one fixed report, and it never calls mutate. Connect it as a Google Ads user with Read only access. Production accounts need a developer token with Basic access",
  settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_LOGIN_CUSTOMER_ID"],
  capabilities: [
    "Imports two years of daily spend, impressions, clicks, conversions and conversion value for every campaign, then keeps them current",
    "Reads the last two weeks again on every sync, as Google keeps attributing conversions to past clicks",
    "Shows each campaign's status, channel and daily budget, so spend that brings in no sales stands out",
    "Pausing a campaign and changing its budget are declared but turned off; each would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
