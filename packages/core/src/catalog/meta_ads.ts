import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects with a system user token holding ads_read only, and stops if the token holds anything more. Its only API requests are the permissions check and the insights read for the one ad account in the settings, built from one fixed report",
  settings: ["META_ADS_ACCESS_TOKEN", "META_ADS_ACCOUNT_ID"],
  capabilities: [
    "Imports two years of daily Facebook and Instagram ad spend, reach, clicks and purchases for every campaign, then keeps them current",
    "Reads the last two weeks again on every sync, as Meta keeps attributing purchases to past views and clicks",
    "Sits beside Google Ads, so spend and what it brought back compare across both",
    "Pausing a campaign and changing its budget are declared but turned off; each would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
