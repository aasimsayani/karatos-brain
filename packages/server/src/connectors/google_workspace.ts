import { googleWorkspaceConnector, memoryTokenStore, parseCalendarIds, parseSharedDriveIds, parseSheetRanges } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_WORKSPACE_REFRESH_TOKEN", "GOOGLE_DRIVE_ROOT_FOLDER_ID", "CORRESPONDENT_HASH_KEY"]),
  make: async (env, store) => {
    const seed = setting(env, "GOOGLE_WORKSPACE_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "GOOGLE_CLIENT_SECRET")!;
    const fileNames = setting(env, "GOOGLE_DRIVE_FILE_NAMES");
    if (fileNames !== undefined && fileNames !== "keep" && fileNames !== "drop") throw new Error("GOOGLE_DRIVE_FILE_NAMES must be keep or drop");
    return googleWorkspaceConnector({
      clientId: setting(env, "GOOGLE_CLIENT_ID")!,
      clientSecret,
      rootFolderId: setting(env, "GOOGLE_DRIVE_ROOT_FOLDER_ID")!,
      sharedDriveIds: parseSharedDriveIds(env.GOOGLE_DRIVE_SHARED_DRIVE_IDS),
      sheets: parseSheetRanges(env.GOOGLE_SHEETS_RANGES),
      calendarIds: parseCalendarIds(env.GOOGLE_CALENDAR_IDS),
      correspondentKey: setting(env, "CORRESPONDENT_HASH_KEY")!,
      ...(fileNames ? { fileNames } : {}),
      // Same OAuth client as Gmail, but its own refresh token, sealed in the database like QuickBooks' if Google ever returns a new one.
      tokens: store ? sealedTokenStore({ ...store, source: "google_workspace", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
