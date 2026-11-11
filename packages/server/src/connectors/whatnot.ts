import { whatnotConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["WHATNOT_ACCESS_TOKEN"]),
  make: async (env) => whatnotConnector({ accessToken: setting(env, "WHATNOT_ACCESS_TOKEN")! }),
} satisfies ConnectorFactory;
