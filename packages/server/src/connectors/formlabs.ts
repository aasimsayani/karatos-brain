import { formlabsConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["FORMLABS_CLIENT_ID", "FORMLABS_CLIENT_SECRET"]),
  make: async (env) => formlabsConnector({ clientId: setting(env, "FORMLABS_CLIENT_ID")!, clientSecret: setting(env, "FORMLABS_CLIENT_SECRET")! }),
} satisfies ConnectorFactory;
