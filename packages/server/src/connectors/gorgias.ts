import { gorgiasConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["GORGIAS_DOMAIN", "GORGIAS_CLIENT_ID", "GORGIAS_CLIENT_SECRET", "GORGIAS_REFRESH_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    gorgiasConnector({
      domain: setting(env, "GORGIAS_DOMAIN")!,
      clientId: setting(env, "GORGIAS_CLIENT_ID")!,
      clientSecret: setting(env, "GORGIAS_CLIENT_SECRET")!,
      refreshToken: setting(env, "GORGIAS_REFRESH_TOKEN")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
