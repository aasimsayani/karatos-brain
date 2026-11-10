import { etsyConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["ETSY_KEYSTRING", "ETSY_SHARED_SECRET", "ETSY_REFRESH_TOKEN", "ETSY_SHOP_ID"]),
  make: async (env, store) => {
    const seed = setting(env, "ETSY_REFRESH_TOKEN")!;
    const keystring = setting(env, "ETSY_KEYSTRING")!;
    const sharedSecret = setting(env, "ETSY_SHARED_SECRET")!;
    return etsyConnector({
      keystring,
      sharedSecret,
      shopId: setting(env, "ETSY_SHOP_ID")!,
      // Etsy may hand back a new refresh token on a refresh; the newest is kept, encrypted with a key from the app's keystring and shared secret (a shared secret alone is too short), in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "etsy", seed, keyMaterial: `${keystring}:${sharedSecret}` }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
