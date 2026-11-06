import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the client sends only its four listed GETs and names every field it reads. It stops if an OAuth token has a write scope; a personal access token's scopes aren't reported, so make it with data.records:read and schema.bases:read only. No webhooks yet; the sync polls",
  webhooks: false,
  settings: ["AIRTABLE_ACCESS_TOKEN", "AIRTABLE_BASE_IDS"],
  capabilities: [
    "Imports five years of records from every base you share, such as memo logs, repair intake and custom orders, then keeps them current",
    "Keeps each record's numbers, money, percents, ratings, checkboxes, dates, select options and links to other records",
    "Knows each table's fields, so a department can tell which one holds a stage, a price or a due date",
    "Never asks Airtable for text, email, phone, attachment, collaborator, formula or lookup fields, where customers' names are written",
    "Read-only: KaratOS never creates or changes anything in Airtable",
  ],
} satisfies ConnectorCatalogEntry;
