import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read scopes only; KaratOS checks the token's scopes before every sync and stops if one could change data. Pinned to HubSpot's 2026-09 API version, and the docs watch follows HubSpot's changelog",
  capabilities: [
    "Imports five years of contacts, companies, deals, tickets and logged calls, emails, meetings, notes and tasks",
    "Keeps every change after that within the sync interval, including records deleted in HubSpot",
    "Shows each deal's pipeline, stage, amount and close date, linked to its contacts and companies",
    "Keeps contact names only: no email addresses, phone numbers, addresses, notes, email bodies or call recordings",
    "Read-only: the private app holds read scopes only, and KaratOS stops if it could ever change your CRM",
  ],
} satisfies ConnectorCatalogEntry;
