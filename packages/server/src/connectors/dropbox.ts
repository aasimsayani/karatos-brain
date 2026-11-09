import { dropboxConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "DROPBOX_REFRESH_TOKEN", "DROPBOX_FOLDER"]),
  make: async (env) =>
    dropboxConnector({
      appKey: setting(env, "DROPBOX_APP_KEY")!,
      appSecret: setting(env, "DROPBOX_APP_SECRET")!,
      refreshToken: setting(env, "DROPBOX_REFRESH_TOKEN")!,
      folder: setting(env, "DROPBOX_FOLDER")!,
      fileNames: (setting(env, "DROPBOX_FILE_NAMES") ?? "keep") as "keep" | "drop",
    }),
} satisfies ConnectorFactory;
