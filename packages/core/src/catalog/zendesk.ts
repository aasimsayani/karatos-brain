import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads Zendesk's incremental ticket and user exports with an admin-made OAuth token scoped to tickets:read and users:read; the client stops if the token has a scope that writes, and keeps each rotated refresh token encrypted in the instance's database. The first client's connection confirms the mock built from Zendesk's docs",
  capabilities: [
    "Imports five years of helpdesk tickets and customers, then reads only what changed on each sync",
    "Shows each ticket's status, type, priority, channel, tags, requester, assignee, group, satisfaction rating and times",
    "Links each Zendesk customer to the same customer as forms, Klaviyo, Quo and Gorgias, without keeping the email address or phone number",
    "Keeps no subjects, comments, descriptions, names or custom fields",
    "Read-only: KaratOS never replies, tags or changes a ticket",
  ],
  settings: ["ZENDESK_SUBDOMAIN", "ZENDESK_CLIENT_ID", "ZENDESK_CLIENT_SECRET", "ZENDESK_REFRESH_TOKEN", "CUSTOMER_REF_KEY"],
} satisfies ConnectorCatalogEntry;
