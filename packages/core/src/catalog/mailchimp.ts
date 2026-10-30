import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "A Mailchimp API key can't be limited to reading, so the client sends its five listed GET reads only and throws before anything else. Every read names the fields it wants, so names, phone numbers, addresses and merge fields never leave Mailchimp",
  settings: ["MAILCHIMP_API_KEY", "CUSTOMER_REF_KEY"],
  capabilities: [
    "Imports every audience and subscriber, and five years of sent campaigns with their reports, then keeps them current",
    "Shows each campaign's sends, opens, clicks, bounces, unsubscribes and the orders and revenue it brought in",
    "Keeps each subscriber's status and consent, linked to the same person's forms, bookings and Klaviyo profile",
    "Never keeps a subscriber's email address, name, phone number, birthday or address",
    "Read-only: KaratOS never adds, changes or emails anyone in Mailchimp",
  ],
} satisfies ConnectorCatalogEntry;
