import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Reads Messenger and Instagram DMs with a Page access token over the Graph API, and WhatsApp only from signed webhooks, since WhatsApp has no history to read. Meta has no read-only messaging permission, so the client only ever sends GETs. Only the 20 latest messages of each conversation can be read",
  capabilities: [
    "Imports every Messenger and Instagram conversation from the last five years, then keeps them current on each sync",
    "Takes each WhatsApp message and delivery status as Meta sends it, checking the signature on every delivery",
    "Shows who wrote, on which app, and whether each message came from the customer or the store",
    "Links each WhatsApp customer to the same customer as Quo, forms and Klaviyo, without keeping the number",
    "Keeps no message text, attachments, names, emails, usernames or phone numbers",
    "Read-only: KaratOS never sends a reply or marks a conversation read",
  ],
  settings: ["META_APP_ID", "META_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "META_PAGE_ID", "META_PAGE_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
