import { teamsConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["MICROSOFT_TENANT_ID", "MICROSOFT_TEAMS_CLIENT_ID", "MICROSOFT_TEAMS_CLIENT_SECRET", "MICROSOFT_TEAMS_TEAM_ID", "CORRESPONDENT_HASH_KEY"]),
  make: async (env) =>
    teamsConnector({
      tenantId: setting(env, "MICROSOFT_TENANT_ID")!,
      clientId: setting(env, "MICROSOFT_TEAMS_CLIENT_ID")!,
      clientSecret: setting(env, "MICROSOFT_TEAMS_CLIENT_SECRET")!,
      teamId: setting(env, "MICROSOFT_TEAMS_TEAM_ID")!,
      correspondentKey: setting(env, "CORRESPONDENT_HASH_KEY")!,
    }),
} satisfies ConnectorFactory;
