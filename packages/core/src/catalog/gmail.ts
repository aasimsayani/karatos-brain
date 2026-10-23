import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Metadata scope only, which Google classes as restricted: an app outside one Workspace organization needs Google's verification before production use, and a consent screen left in Testing gives tokens that last seven days. Push through Pub/Sub isn't used; the scheduled sync reads the mailbox history",
  capabilities: [
    "Imports five years of mail metadata from one mailbox: who wrote to whom, when, which thread and which labels",
    "Keeps label changes and deletions after that from the mailbox history, within the sync interval",
    "Tells vendor mail from customer mail by the sender's business domain, so buying sees which suppliers write most",
    "Never reads message bodies, attachments or subjects, and keeps no email addresses, only a private reference per person",
    "Read-only: the connection can't read or change mail content, and KaratOS stops if it is ever granted more",
  ],
  settings: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "CORRESPONDENT_HASH_KEY"],
} satisfies ConnectorCatalogEntry;
