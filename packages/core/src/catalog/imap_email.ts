import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Signs in with LOGIN and an app password over implicit TLS only (port 993 by default); STARTTLS and plaintext aren't supported. Opens folders with EXAMINE and fetches header fields with BODY.PEEK, so nothing is ever marked read. Tested against a scripted RFC 3501 server; the first live mailbox confirms each provider's folder names",
  capabilities: [
    "Imports five years of mail metadata from INBOX and Sent on any IMAP mailbox: who wrote to whom, when and which thread",
    "Keeps up with new mail after that by UID, folder by folder, and reads a folder again if its server renumbers it",
    "Tells vendor mail from customer mail by the sender's business domain, the same way Gmail's and Outlook's connectors do",
    "Never fetches message bodies, attachments or subjects, and keeps no email addresses, only a private reference per person",
    "Read-only: folders open with EXAMINE and messages are read with PEEK, so KaratOS never marks, moves or deletes mail",
  ],
  settings: ["IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD", "CORRESPONDENT_HASH_KEY"],
} satisfies ConnectorCatalogEntry;
