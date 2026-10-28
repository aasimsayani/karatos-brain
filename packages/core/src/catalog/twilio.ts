import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Text message and call logs through a restricted API key with read permissions only. Message bodies are never kept, and no webhooks, since pointing a number's webhook at KaratOS would change how the store's line answers",
  webhooks: false,
  settings: ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_CONTACT_KEY"],
  capabilities: [
    "Imports five years of the store's texts, WhatsApp messages and calls: who, when, which line and how each one ended",
    "Flags customers who called and couldn't get through, until someone calls or texts them back",
    "Shows delivery failures and what each text and call cost",
    "Keeps no message bodies and no phone numbers: each customer becomes a keyed reference",
    "Read-only: a restricted API key that can only read the logs, and the account's Auth Token is turned down",
  ],
} satisfies ConnectorCatalogEntry;
