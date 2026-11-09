import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: every token is asked for account_info.read and files.metadata.read only (and files.content.read for file imports), and the client stops if Dropbox reports more. Webhooks only say an account changed, so a verified one prompts the incremental sync. Dropbox publishes no API changelog; changes are announced on its developer blog",
  webhooks: true,
  settings: ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "DROPBOX_REFRESH_TOKEN", "DROPBOX_FOLDER", "DROPBOX_FILE_NAMES"],
  capabilities: [
    "Imports the names, kinds, folders, sizes and edit times of the files in the folder you share, then keeps up with every change",
    "Sees files that are added, edited, moved or deleted, such as a new statement, invoice, appraisal or design file",
    "Knows each file's kind, such as a PDF statement, a spreadsheet, a photo or a CAD design file",
    "Never keeps folder paths, sharing or who made a change, and file names can be left out",
    "Read-only: the token can't change, move or share anything in Dropbox",
  ],
} satisfies ConnectorCatalogEntry;
