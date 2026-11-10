import { microsoftOneDriveConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_ONEDRIVE_DRIVE_ID"]),
  make: async (env) =>
    microsoftOneDriveConnector({
      tenantId: setting(env, "MICROSOFT_TENANT_ID")!,
      clientId: setting(env, "MICROSOFT_CLIENT_ID")!,
      clientSecret: setting(env, "MICROSOFT_CLIENT_SECRET")!,
      driveId: setting(env, "MICROSOFT_ONEDRIVE_DRIVE_ID")!,
      fileNames: (setting(env, "MICROSOFT_ONEDRIVE_FILE_NAMES") ?? "keep") as "keep" | "drop",
      clientState: setting(env, "MICROSOFT_GRAPH_CLIENT_STATE"),
    }),
} satisfies ConnectorFactory;
