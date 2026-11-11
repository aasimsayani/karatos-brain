import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the app is meant to hold Exchange's Application Mail.ReadBasic and Application Calendars.Read roles for one mailbox only, through RBAC for Applications, and the client stops if its token carries any permission that isn't a read one. Mail.ReadBasic can't see bodies, previews or attachments. Change notifications aren't built; the scheduled sync reads Graph's deltas. Microsoft Graph's changelog is watched through this entry",
  webhooks: false,
  settings: ["MICROSOFT_TENANT_ID", "MICROSOFT_OUTLOOK_CLIENT_ID", "MICROSOFT_OUTLOOK_CLIENT_SECRET", "MICROSOFT_OUTLOOK_MAILBOX", "CORRESPONDENT_HASH_KEY"],
  capabilities: [
    "Imports five years of the mailbox's Inbox and Sent Items, then keeps up with every new, changed and removed message",
    "Knows who the store writes to and hears from, and how recently, with customers and vendors as private references",
    "Imports the calendar from five years back to a year ahead: appointments, who was invited, who accepted, and cancellations",
    "Never keeps subjects, message bodies, attachments, event titles, locations or meeting links",
    "Read-only: the app is given read on one mailbox and can't send, move, delete or book anything",
  ],
} satisfies ConnectorCatalogEntry;
