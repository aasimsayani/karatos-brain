import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Reads with the account's numeric user id and API key over Basic auth. The key reaches the whole account and Acuity has no read-only key or scope, so read-only is enforced in code: the client only ever sends GETs. API access needs the Premium or Powerhouse plan, and there is no sandbox",
  webhooks: false,
  settings: ["ACUITY_USER_ID", "ACUITY_API_KEY", "CUSTOMER_REF_KEY"],
  capabilities: [
    "Imports two years of appointments and the 90 days ahead, such as bridal consultations, repair drop-offs and pickups",
    "Keeps appointments from 60 days back to 90 days ahead current, so moves, cancellations and no-shows are seen",
    "Shows each appointment's kind, type, calendar, time, length, price and amount paid",
    "Links a booking to the same person's form submissions, Calendly bookings and Klaviyo profile without keeping their name, email or phone",
    "Never keeps notes, intake form answers, labels or locations, and never asks Acuity for the forms",
    "Read-only: KaratOS never books, cancels or changes anything in Acuity Scheduling",
  ],
} satisfies ConnectorCatalogEntry;
