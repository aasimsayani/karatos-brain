import { gustoConnector, memoryTokenStore, type GustoEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "GUSTO_REDIRECT_URI", "GUSTO_COMPANY_UUID", "GUSTO_REFRESH_TOKEN"]),
  make: async (env, store) => {
    const seed = setting(env, "GUSTO_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "GUSTO_CLIENT_SECRET")!;
    const environment = setting(env, "GUSTO_ENVIRONMENT");
    return gustoConnector({
      clientId: setting(env, "GUSTO_CLIENT_ID")!,
      clientSecret,
      redirectUri: setting(env, "GUSTO_REDIRECT_URI")!,
      companyUuid: setting(env, "GUSTO_COMPANY_UUID")!,
      ...(environment ? { environment: environment as GustoEnvironment } : {}),
      // Gusto replaces the refresh token on every refresh; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "gusto", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
