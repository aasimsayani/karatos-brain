import { memoryTokenStore, tiktokConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"]),
  make: async (env, store) => {
    const seed = setting(env, "TIKTOK_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "TIKTOK_CLIENT_SECRET")!;
    return tiktokConnector({
      clientKey: setting(env, "TIKTOK_CLIENT_KEY")!,
      clientSecret,
      // TikTok may replace the refresh token on a refresh; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "tiktok", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
