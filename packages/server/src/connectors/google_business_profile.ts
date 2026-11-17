import { gbpConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN", "GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID"]),
  make: async (env, store) => {
    const seed = setting(env, "GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "GOOGLE_CLIENT_SECRET")!;
    return gbpConnector({
      clientId: setting(env, "GOOGLE_CLIENT_ID")!,
      clientSecret,
      accountId: setting(env, "GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID")!,
      // Same OAuth client as the other Google connectors, but its own refresh token, sealed in the database if Google ever returns a new one.
      tokens: store ? sealedTokenStore({ ...store, source: "google_business_profile", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
