import { amazonConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AMAZON_SP_CLIENT_ID", "AMAZON_SP_CLIENT_SECRET", "AMAZON_SP_REFRESH_TOKEN"]),
  // An LWA refresh token doesn't change when it is used, so there is nothing to store.
  make: async (env) =>
    amazonConnector({
      clientId: setting(env, "AMAZON_SP_CLIENT_ID")!,
      clientSecret: setting(env, "AMAZON_SP_CLIENT_SECRET")!,
      refreshToken: setting(env, "AMAZON_SP_REFRESH_TOKEN")!,
      marketplaceId: setting(env, "AMAZON_SP_MARKETPLACE_ID"),
      region: setting(env, "AMAZON_SP_REGION"),
      environment: setting(env, "AMAZON_SP_ENVIRONMENT"),
    }),
} satisfies ConnectorFactory;
