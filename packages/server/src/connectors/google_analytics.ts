import { googleAnalyticsConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ANALYTICS_REFRESH_TOKEN", "GOOGLE_ANALYTICS_PROPERTY_ID"]),
  make: async (env, store) => {
    const seed = setting(env, "GOOGLE_ANALYTICS_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "GOOGLE_CLIENT_SECRET")!;
    return googleAnalyticsConnector({
      clientId: setting(env, "GOOGLE_CLIENT_ID")!,
      clientSecret,
      propertyId: setting(env, "GOOGLE_ANALYTICS_PROPERTY_ID")!,
      // Same OAuth client as Gmail and Google Workspace, but its own refresh token, sealed in the database if Google ever returns a new one.
      tokens: store ? sealedTokenStore({ ...store, source: "google_analytics", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
