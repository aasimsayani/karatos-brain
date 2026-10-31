import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects a Pinterest business account through an app the store owns, holding boards:read, pins:read and user_accounts:read only; the connector stops if the token holds anything more. Its only API requests are the Pin list and two analytics reads. Pinterest's analytics reach back 90 days, so the first import reads 90 days of metrics and every Pin",
  settings: ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET", "PINTEREST_REFRESH_TOKEN"],
  historicalImportYears: 0,
  capabilities: [
    "Imports every Pin the store has made, with its title, the page it links to and its 90-day and lifetime metrics",
    "Ranks the store's 50 most saved Pins over the last 30 days, so the rings and styles shoppers save most stand out",
    "Reads the account's daily impressions, saves, Pin clicks and outbound clicks for the 90 days Pinterest keeps",
    "Keeps no Pin description, and drops a title holding an @ and a link's query string",
    "Creating a Pin for a product is declared but turned off, and would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
