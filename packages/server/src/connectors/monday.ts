import { mondayConnector, parseMondayAllowedColumns, parseMondayScopes } from "@karatos/connectors";
import { setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => (setting(env, "MONDAY_API_TOKEN") ? [] : ["MONDAY_API_TOKEN"]),
  make: async (env) => {
    const scopes = parseMondayScopes(setting(env, "MONDAY_OAUTH_SCOPES"));
    return mondayConnector({
      token: setting(env, "MONDAY_API_TOKEN")!,
      // Given for a monday app's OAuth token, so one holding a write scope is refused; a personal token has none to give.
      ...(scopes ? { scopes } : {}),
      allowedColumns: parseMondayAllowedColumns(setting(env, "MONDAY_ALLOWED_COLUMNS")),
    });
  },
} satisfies ConnectorFactory;
