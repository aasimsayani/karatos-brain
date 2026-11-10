import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the app is meant to have Sites.Selected with the read role on one site, and the client stops if its token carries any permission that isn't a read one. Graph's notifications only say the drive changed, so one carrying the subscription's clientState prompts the incremental sync. Graph's one changelog is watched through the Outlook entry",
  webhooks: true,
  settings: ["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_ONEDRIVE_DRIVE_ID", "MICROSOFT_ONEDRIVE_FILE_NAMES", "MICROSOFT_GRAPH_CLIENT_STATE"],
  capabilities: [
    "Imports the names, kinds, folders, sizes and edit times of the files in the library you share, then keeps up with every change",
    "Sees files that are added, edited, renamed, moved or deleted in OneDrive or SharePoint, such as a new statement or invoice",
    "Knows each file's kind, such as a PDF statement, a spreadsheet, a photo or a CAD design file",
    "Never keeps paths, sharing, links or who made a change, and file names can be left out",
    "Read-only: the app is granted read on one site and can't change, move or share anything",
  ],
} satisfies ConnectorCatalogEntry;
