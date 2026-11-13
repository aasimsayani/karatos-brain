import { katanaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["KATANA_API_KEY"]),
  make: async (env) => katanaConnector({ apiKey: setting(env, "KATANA_API_KEY")! }),
} satisfies ConnectorFactory;
