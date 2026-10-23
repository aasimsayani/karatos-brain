import { hubSpotConnector } from "@karatos/connectors";
import { setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => (setting(env, "HUBSPOT_ACCESS_TOKEN") ? [] : ["HUBSPOT_ACCESS_TOKEN"]),
  // A private app token doesn't expire or rotate on its own, so there is nothing to keep between runs.
  make: async (env) => hubSpotConnector({ accessToken: setting(env, "HUBSPOT_ACCESS_TOKEN")! }),
} satisfies ConnectorFactory;
