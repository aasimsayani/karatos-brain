import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: the client sends only its five listed GETs and names every field it reads. A personal access token can do whatever its user can, so make it as a user with access to only the projects to sync, or use an OAuth app limited to read scopes. No webhooks yet; the sync polls",
  webhooks: false,
  settings: ["ASANA_ACCESS_TOKEN", "ASANA_WORKSPACE_GID"],
  capabilities: [
    "Imports five years of tasks from every project you can see, such as repairs, custom orders and production jobs, then keeps them current",
    "Keeps each task's section, due and start dates, assignee, whether it is done, and its number, select, date and people fields",
    "Notices archived projects, and who commented on a task and when",
    "Never asks Asana for task names, notes, comment text or text fields, where customers' names are written",
    "Read-only: KaratOS never creates or changes anything in Asana",
  ],
} satisfies ConnectorCatalogEntry;
