import { lightspeedConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["LIGHTSPEED_DOMAIN_PREFIX", "LIGHTSPEED_CLIENT_ID", "LIGHTSPEED_CLIENT_SECRET", "LIGHTSPEED_REFRESH_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env, store) => {
    const seed = setting(env, "LIGHTSPEED_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "LIGHTSPEED_CLIENT_SECRET")!;
    return lightspeedConnector({
      domainPrefix: setting(env, "LIGHTSPEED_DOMAIN_PREFIX")!,
      clientId: setting(env, "LIGHTSPEED_CLIENT_ID")!,
      clientSecret,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      // Lightspeed replaces the refresh token on every refresh; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "lightspeed", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
