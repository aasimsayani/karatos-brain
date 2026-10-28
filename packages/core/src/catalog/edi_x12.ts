import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "X12 files from the business's VAN or SFTP mailbox: purchase orders, acknowledgments, ship notices, invoices, inventory and sell-through",
  capabilities: [
    "Imports two years of purchase orders (850), inventory reports (846) and sell-through (852) from retail partners",
    "Reads the copies of the acknowledgments (855), ship notices (856) and invoices (810) the business sent back",
    "Checks every envelope's control numbers and counts, and names the file and document when one doesn't add up",
    "Stores an order a partner sends twice once, and a changed order as a new version",
    "Read-only: KaratOS only reads the mailbox folder and never sends a document to a partner",
  ],
  settings: ["EDI_IMPORT_DIR"],
} satisfies ConnectorCatalogEntry;
