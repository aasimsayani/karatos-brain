import { stripeConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["STRIPE_SECRET_KEY"]),
  make: async (env) => {
    const version = setting(env, "STRIPE_API_VERSION");
    return stripeConnector({ secretKey: setting(env, "STRIPE_SECRET_KEY")!, ...(version ? { apiVersion: version } : {}) });
  },
} satisfies ConnectorFactory;
