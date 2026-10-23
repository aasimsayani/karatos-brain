import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the connector only sends its own read queries, and a monday app token holding any write scope is turned away. A personal token can't be limited to reading, so a monday app token with boards:read and updates:read is the safer choice. The docs watch follows the API changelog, and the nightly run against a free developer account catches API changes",
  capabilities: [
    "Imports five years of items from every board you can see, such as custom orders, repairs and production jobs, then keeps them current",
    "Keeps each item's stage, dates, numbers, checkboxes, dropdown labels, timelines and assigned people",
    "Notices items deleted or archived in monday.com",
    "Leaves out text, notes, emails, phone numbers, addresses, files and links unless you allow a column",
    "Never keeps item names or what a comment says, only who commented and when",
    "Read-only: KaratOS never creates or changes anything in monday.com",
  ],
} satisfies ConnectorCatalogEntry;
