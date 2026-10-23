import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only scopes only. drive.metadata.readonly is restricted: an app outside one Workspace organization needs Google's verification before production use, and a consent screen left in Testing gives tokens that last seven days. Push channels stay behind the write gate; the scheduled sync reads Drive's change feed and Calendar's sync tokens",
  capabilities: [
    "Imports the names, types, folders, sizes and edit times of the files in the folder the business shares, then keeps up with every change",
    "Reads the Sheets ranges the owner lists, such as a price list or a stock count, and stores a new version whenever they change",
    "Imports five years of appointments from the listed calendars, then keeps new, moved and cancelled ones",
    "Never downloads files and never keeps appointment titles, descriptions, meeting links or attendee addresses",
    "Read-only: the connection can't change files or calendars, and KaratOS stops if it is ever granted more",
  ],
  settings: [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_WORKSPACE_REFRESH_TOKEN",
    "GOOGLE_DRIVE_ROOT_FOLDER_ID",
    "CORRESPONDENT_HASH_KEY",
  ],
} satisfies ConnectorCatalogEntry;
