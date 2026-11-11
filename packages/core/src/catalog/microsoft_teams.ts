import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the app is meant to hold only ChannelMessage.Read.Group and ChannelSettings.Read.Group, the resource-specific consent permissions a team grants when it installs the app, so it reads that one team and nothing else, and the client stops if its token carries any permission that isn't a read one. Message text is never kept. Change notifications aren't built; the scheduled sync lists each channel's newest changes. Microsoft Graph's changelog is watched through the Outlook entry",
  webhooks: false,
  settings: ["MICROSOFT_TENANT_ID", "MICROSOFT_TEAMS_CLIENT_ID", "MICROSOFT_TEAMS_CLIENT_SECRET", "MICROSOFT_TEAMS_TEAM_ID", "CORRESPONDENT_HASH_KEY"],
  capabilities: [
    "Imports five years of one team's channel messages and replies, then keeps up with every new, edited and deleted one",
    "Shows who hands off repairs, custom orders and sales to whom, in which channel and thread, and how busy each channel is",
    "Keeps people as private references, the same person the same reference across channels",
    "Never keeps message text, subjects, attachments, channel names or display names",
    "Read-only: the app is installed in one team with read permissions and can't post, edit or delete anything",
  ],
} satisfies ConnectorCatalogEntry;
