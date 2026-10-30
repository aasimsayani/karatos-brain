import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects with analytics.readonly only and stops if the token holds anything more. Its only API request is runReport for the one property in the settings, built from two fixed reports",
  settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ANALYTICS_REFRESH_TOKEN", "GOOGLE_ANALYTICS_PROPERTY_ID"],
  capabilities: [
    "Imports two years of daily website sessions, users and new users by channel and by source and medium, then keeps them current",
    "Shows the key events, purchases and revenue each channel brought in",
    "Shows how often each product was viewed, added to cart and bought online",
    "Reports are totals by day, so no visitor is ever named",
    "Read-only: KaratOS never changes anything in Google Analytics",
  ],
} satisfies ConnectorCatalogEntry;
