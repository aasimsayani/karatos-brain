import { googleAdsConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"]),
  make: async (env, store) => {
    const seed = setting(env, "GOOGLE_ADS_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "GOOGLE_CLIENT_SECRET")!;
    return googleAdsConnector({
      clientId: setting(env, "GOOGLE_CLIENT_ID")!,
      clientSecret,
      developerToken: setting(env, "GOOGLE_ADS_DEVELOPER_TOKEN")!,
      customerId: setting(env, "GOOGLE_ADS_CUSTOMER_ID")!,
      // Only when the connected user reaches the account through a manager account.
      loginCustomerId: setting(env, "GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
      // Same OAuth client as the other Google connectors, but its own refresh token, sealed in the database if Google ever returns a new one.
      tokens: store ? sealedTokenStore({ ...store, source: "google_ads", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
