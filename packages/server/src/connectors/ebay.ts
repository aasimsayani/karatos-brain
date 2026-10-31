import { ebayConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_REFRESH_TOKEN"]),
  // eBay never returns a new refresh token, so there is nothing to store.
  make: async (env) =>
    ebayConnector({
      clientId: setting(env, "EBAY_CLIENT_ID")!,
      clientSecret: setting(env, "EBAY_CLIENT_SECRET")!,
      refreshToken: setting(env, "EBAY_REFRESH_TOKEN")!,
      environment: setting(env, "EBAY_ENVIRONMENT"),
    }),
} satisfies ConnectorFactory;
