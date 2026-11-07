import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the client sends only a search, a data source read and a query, and names every property it reads. Notion's API can't report a connection's capabilities, so make the connection with Read content only. No webhooks yet; the sync polls",
  webhooks: false,
  settings: ["NOTION_ACCESS_TOKEN", "NOTION_DATA_SOURCE_IDS"],
  capabilities: [
    "Imports five years of pages from every database you share, such as repairs, custom orders and buying, then keeps them current",
    "Keeps each page's numbers, checkboxes, dates, selects, statuses, relations, people and unique ids",
    "Knows each database's properties, so a department can tell which one holds a status, a price or a due date",
    "Never asks Notion for titles, text, email, phone, URL, file, formula or rollup properties, where customers' names are written",
    "Read-only: KaratOS never creates or changes anything in Notion",
  ],
} satisfies ConnectorCatalogEntry;
