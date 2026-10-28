import { stullerConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["STULLER_USERNAME", "STULLER_PASSWORD"]),
  make: async (env) => stullerConnector({ username: setting(env, "STULLER_USERNAME")!, password: setting(env, "STULLER_PASSWORD")! }),
} satisfies ConnectorFactory;
