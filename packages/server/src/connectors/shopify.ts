import { shopifyConnector } from "@karatos/connectors";
import { setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => [
    ...(setting(env, "SHOPIFY_SHOP_DOMAIN") ? [] : ["SHOPIFY_SHOP_DOMAIN"]),
    ...(setting(env, "SHOPIFY_ADMIN_ACCESS_TOKEN") || (setting(env, "SHOPIFY_CLIENT_ID") && setting(env, "SHOPIFY_CLIENT_SECRET"))
      ? []
      : ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]),
  ],
  make: async (env) => {
    const token = setting(env, "SHOPIFY_ADMIN_ACCESS_TOKEN");
    const version = setting(env, "SHOPIFY_API_VERSION");
    return shopifyConnector({
      shopDomain: setting(env, "SHOPIFY_SHOP_DOMAIN")!,
      ...(token ? { accessToken: token } : { clientId: setting(env, "SHOPIFY_CLIENT_ID")!, clientSecret: setting(env, "SHOPIFY_CLIENT_SECRET")! }),
      ...(version ? { apiVersion: version } : {}),
    });
  },
} satisfies ConnectorFactory;
