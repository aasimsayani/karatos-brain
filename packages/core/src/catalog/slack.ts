import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Bot token with read scopes only, as an internal app made in the business's own workspace. Since May 2025 an app distributed outside the Slack Marketplace may read history only once a minute, 15 messages at a time, so a five-year import needs the internal app. Events API webhooks are verified but the instance doesn't take them yet; the scheduled sync reads the same messages",
  capabilities: [
    "Imports five years of messages and threads from the channels the KaratOS app is invited to, and nothing else",
    "Keeps who posted, when, in which channel and thread, with reply, file and reaction counts",
    "Keeps message text only for the channels the owner lists, with emails, phone numbers and other long numbers taken out",
    "Never keeps names or Slack profiles, only a private reference per person, and counts files without opening them",
    "Read-only: the app holds no permission to post, and KaratOS stops if it is ever given one",
  ],
  settings: ["SLACK_BOT_TOKEN", "CORRESPONDENT_HASH_KEY"],
} satisfies ConnectorCatalogEntry;
