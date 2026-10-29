import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: a personal access token with only the users:read and scheduled_events:read scopes, and the client sends only its three listed reads. No webhooks, since subscribing needs a paid plan and the webhooks:write scope; the sync polls instead",
  webhooks: false,
  settings: ["CALENDLY_ACCESS_TOKEN", "CUSTOMER_REF_KEY"],
  capabilities: [
    "Imports two years of appointments and the year ahead, such as bridal consultations, repair drop-offs and pickups, then keeps them current",
    "Shows each appointment's kind, time, length, host, and whether it was in person, by phone or on video",
    "Notices cancellations, reschedules and no-shows, and who cancelled",
    "Links a booking to the same person's form submissions and Klaviyo profile without keeping their name, email address or phone number",
    "Never keeps answers to the booking questions, meeting notes, cancellation reasons or addresses",
    "Read-only: KaratOS never books, cancels or changes anything in Calendly",
  ],
} satisfies ConnectorCatalogEntry;
