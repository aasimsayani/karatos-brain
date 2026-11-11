import { memoryTokenStore, zendeskConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["ZENDESK_SUBDOMAIN", "ZENDESK_CLIENT_ID", "ZENDESK_CLIENT_SECRET", "ZENDESK_REFRESH_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env, store) => {
    const seed = setting(env, "ZENDESK_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "ZENDESK_CLIENT_SECRET")!;
    return zendeskConnector({
      subdomain: setting(env, "ZENDESK_SUBDOMAIN")!,
      clientId: setting(env, "ZENDESK_CLIENT_ID")!,
      clientSecret,
      // Zendesk rotates the refresh token on every refresh; the newest is kept, encrypted, in the instance's database.
      tokens: store ? sealedTokenStore({ ...store, source: "zendesk", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    });
  },
} satisfies ConnectorFactory;
