import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects with a long-lived advertiser token from a TikTok developer app made with read scopes only (Ad Account Information and Reporting). Its only API request is the report read for the one advertiser in the settings, built from one fixed report",
  settings: ["TIKTOK_ADS_ACCESS_TOKEN", "TIKTOK_ADS_ADVERTISER_ID", "TIKTOK_ADS_ENVIRONMENT"],
  capabilities: [
    "Imports two years of daily TikTok ad spend, impressions, reach, clicks and purchases for every campaign, then keeps them current",
    "Reads the last four weeks again on every sync, as TikTok keeps attributing purchases to past views and clicks",
    "Sits beside Google Ads and Meta Ads, so spend and what it brought back compare across all three",
    "Pausing and resuming a campaign are declared but turned off; each would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
