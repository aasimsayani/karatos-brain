import { rapnetConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["RAPNET_CLIENT_ID", "RAPNET_CLIENT_SECRET"]),
  make: async (env) => rapnetConnector({ clientId: setting(env, "RAPNET_CLIENT_ID")!, clientSecret: setting(env, "RAPNET_CLIENT_SECRET")! }),
} satisfies ConnectorFactory;
