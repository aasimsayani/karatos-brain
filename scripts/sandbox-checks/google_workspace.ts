import type { SandboxCheck } from "@karatos/core";
import { googleWorkspaceConnector, memoryTokenStore, parseSheetRanges } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A Google account made for testing, holding only a synthetic folder, spreadsheet and calendar, connected to a test
// OAuth client with drive.metadata.readonly, spreadsheets.readonly and calendar.events.readonly only. Google has no
// Workspace sandbox. A consent screen in Testing gives refresh tokens that expire after 7 days, so when the run fails
// with invalid_grant, reconnect the test account and update the secret. The correspondent key is new each run.
export default {
  integration: "google_workspace",
  name: "Google Workspace and Drive",
  credentials: ["SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID", "SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET", "SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN", "SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID", "SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE"],
  connector: (c) =>
    googleWorkspaceConnector({
      clientId: c.SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID!,
      clientSecret: c.SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET!,
      rootFolderId: c.SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID!,
      sheets: parseSheetRanges(c.SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE),
      calendarIds: ["primary"],
      correspondentKey: randomBytes(32).toString("hex"),
      tokens: memoryTokenStore(c.SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
