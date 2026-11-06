import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Connects the store's own TikTok account through an app the store owns, holding user.info.basic, user.info.stats and video.list only; the connector stops if the token holds anything more. Its only API requests are the profile read and the video list",
  settings: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"],
  capabilities: [
    "Imports every public video the store posted in the last two years, with its title, link, length and views, likes, comments and shares",
    "Reads the videos of the last 90 days again on each sync, so a video that keeps gaining views shows it",
    "Records the account's followers and total likes each day, so growth can be set against store visits and online sales",
    "Keeps no video description, and drops a title holding an @ and a link's query string",
    "Posting a product video is declared but turned off, and would need a named person's approval",
  ],
} satisfies ConnectorCatalogEntry;
