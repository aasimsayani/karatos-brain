import { auroraConnector } from "@karatos/connectors";
import { missing, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AURORA_CLIENT_ID", "AURORA_CLIENT_SECRET"]),
  // The connector trims each setting and reads a blank environment as production.
  make: async (env) => auroraConnector({ clientId: env.AURORA_CLIENT_ID, clientSecret: env.AURORA_CLIENT_SECRET, environment: env.AURORA_ENVIRONMENT }),
} satisfies ConnectorFactory;
