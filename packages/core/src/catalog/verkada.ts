import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads people in and out by hour from each camera's counting line with a read-only API key, traded for a 30-minute token. Occupancy Trends needs Verkada cameras with it turned on: the first client's organization confirms the mock built from Verkada's docs",
  capabilities: [
    "Imports two years of hourly people counts from every counting line, then the hours since the last sync",
    "Shows how many people came in and went out each hour at each camera and site, to set against sales",
    "Never keeps the site's street address or a video frame",
    "Read-only: the API key is made read-only in Verkada, and KaratOS never changes a camera or setting",
  ],
  settings: ["VERKADA_API_KEY", "VERKADA_REGION"],
} satisfies ConnectorCatalogEntry;
