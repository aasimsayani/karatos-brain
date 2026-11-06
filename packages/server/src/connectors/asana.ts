import { asanaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["ASANA_ACCESS_TOKEN"]),
  make: async (env) => asanaConnector({ token: setting(env, "ASANA_ACCESS_TOKEN")!, workspace: setting(env, "ASANA_WORKSPACE_GID") }),
} satisfies ConnectorFactory;
