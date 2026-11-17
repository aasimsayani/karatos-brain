import { watchTraderHubConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["WATCHTRADERHUB_API_KEY"]),
  make: async (env) => watchTraderHubConnector({ apiKey: setting(env, "WATCHTRADERHUB_API_KEY")! }),
} satisfies ConnectorFactory;
