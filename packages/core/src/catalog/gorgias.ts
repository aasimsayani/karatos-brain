import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads tickets and messages as a Gorgias app connected with tickets:read; the client stops if the token has a scope that writes. Gorgias API keys carry their user's full permissions and Observers can't make one, so it uses an app made in Gorgias's partner portal. The first client's connection confirms the mock built from Gorgias's docs",
  capabilities: [
    "Imports five years of helpdesk tickets and every message on them, then reads only the tickets that changed on each sync",
    "Shows each ticket's status, channel, tags, assignee, satisfaction score, and when it was opened, answered and closed",
    "Links each customer to the same customer as forms, Klaviyo, Quo and AvaTax, without keeping the email address",
    "Keeps no message text, subjects, attachments or customer names",
    "Read-only: KaratOS never replies, tags or changes a ticket",
  ],
  settings: ["GORGIAS_DOMAIN", "GORGIAS_CLIENT_ID", "GORGIAS_CLIENT_SECRET", "GORGIAS_REFRESH_TOKEN", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
