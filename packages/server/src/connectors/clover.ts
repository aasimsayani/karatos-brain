import { cloverConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  // A merchant API token, or the app ID with a refresh token (and the app secret, which seals the stored token).
  needs: (env) => [
    ...missing(env, ["CLOVER_MERCHANT_ID", "CLOVER_REGION", "CUSTOMER_REF_KEY"]),
    ...(setting(env, "CLOVER_API_TOKEN") ? [] : missing(env, ["CLOVER_APP_ID", "CLOVER_APP_SECRET", "CLOVER_REFRESH_TOKEN"])),
  ],
  make: async (env, store) => {
    const apiToken = setting(env, "CLOVER_API_TOKEN");
    const seed = setting(env, "CLOVER_REFRESH_TOKEN");
    const appSecret = setting(env, "CLOVER_APP_SECRET");
    return cloverConnector({
      merchantId: setting(env, "CLOVER_MERCHANT_ID")!,
      region: setting(env, "CLOVER_REGION")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      // Clover retires the refresh token on every refresh; the newest is kept, encrypted, in the instance's database.
      auth: apiToken
        ? { apiToken }
        : { appId: setting(env, "CLOVER_APP_ID")!, tokens: store ? sealedTokenStore({ ...store, source: "clover", seed: seed!, keyMaterial: appSecret! }) : memoryTokenStore(seed!) },
    });
  },
} satisfies ConnectorFactory;
