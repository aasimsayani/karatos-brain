import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  testWith: "paid_account",
  note: "Reads with a permanent token. Deputy has no read-only token or access level, so the client only ever sends the Resource API search for the six records it uses. The vendor docs watch follows Deputy's API changelog; until a trial install is set up, the mock built from Deputy's docs stands in",
  capabilities: [
    "Imports every location, area and team member, and three years of shifts, timesheets and leave, then what changed",
    "Shows scheduled and worked hours and their cost by day, location and area, so labor can be set against sales",
    "Keeps team members as their Deputy ID with location and dates, never a name, birthday, address or contact",
    "Read-only: KaratOS never publishes a schedule or approves a timesheet",
  ],
  settings: ["DEPUTY_ACCESS_TOKEN", "DEPUTY_INSTALL"],
} satisfies ConnectorCatalogEntry;
