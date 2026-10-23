import { memoryTokenStore, quickBooksConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REALM_ID", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_ENVIRONMENT"]),
  make: async (env, store) => {
    const seed = setting(env, "QUICKBOOKS_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "QUICKBOOKS_CLIENT_SECRET")!;
    return quickBooksConnector({
      clientId: setting(env, "QUICKBOOKS_CLIENT_ID")!,
      clientSecret,
      realmId: setting(env, "QUICKBOOKS_REALM_ID")!,
      environment: setting(env, "QUICKBOOKS_ENVIRONMENT")!,
      // Intuit rotates the refresh token daily; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "quickbooks", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
