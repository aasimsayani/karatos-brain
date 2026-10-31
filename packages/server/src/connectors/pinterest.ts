import { memoryTokenStore, pinterestConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["PINTEREST_CLIENT_ID", "PINTEREST_CLIENT_SECRET", "PINTEREST_REFRESH_TOKEN"]),
  make: async (env, store) => {
    const seed = setting(env, "PINTEREST_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "PINTEREST_CLIENT_SECRET")!;
    return pinterestConnector({
      clientId: setting(env, "PINTEREST_CLIENT_ID")!,
      clientSecret,
      // Pinterest replaces the refresh token on every refresh; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "pinterest", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
