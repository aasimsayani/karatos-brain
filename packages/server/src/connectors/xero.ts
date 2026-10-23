import { memoryTokenStore, xeroConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "XERO_TENANT_ID", "XERO_REFRESH_TOKEN"]),
  make: async (env, store) => {
    const seed = setting(env, "XERO_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "XERO_CLIENT_SECRET")!;
    return xeroConnector({
      clientId: setting(env, "XERO_CLIENT_ID")!,
      clientSecret,
      tenantId: setting(env, "XERO_TENANT_ID")!,
      // Xero retires the refresh token on every refresh; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "xero", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
