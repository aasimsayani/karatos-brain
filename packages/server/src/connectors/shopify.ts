import { shopifyConnector } from "@karatos/connectors";
import { setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => [
    ...(setting(env, "SHOPIFY_SHOP_DOMAIN") ? [] : ["SHOPIFY_SHOP_DOMAIN"]),
    ...(setting(env, "SHOPIFY_ADMIN_ACCESS_TOKEN") || (setting(env, "SHOPIFY_CLIENT_ID") && setting(env, "SHOPIFY_CLIENT_SECRET"))
      ? []
      : ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"]),
    // Linking customers hashes their email address and phone number under CUSTOMER_REF_KEY, so it needs the key.
    ...(setting(env, "SHOPIFY_LINK_CUSTOMERS") === "on" && !setting(env, "CUSTOMER_REF_KEY") ? ["CUSTOMER_REF_KEY"] : []),
  ],
  make: async (env) => {
    const token = setting(env, "SHOPIFY_ADMIN_ACCESS_TOKEN");
    const version = setting(env, "SHOPIFY_API_VERSION");
    const link = setting(env, "SHOPIFY_LINK_CUSTOMERS");
    if (link !== undefined && link !== "on" && link !== "off") throw new Error("SHOPIFY_LINK_CUSTOMERS must be on or off");
    return shopifyConnector({
      shopDomain: setting(env, "SHOPIFY_SHOP_DOMAIN")!,
      ...(token ? { accessToken: token } : { clientId: setting(env, "SHOPIFY_CLIENT_ID")!, clientSecret: setting(env, "SHOPIFY_CLIENT_SECRET")! }),
      ...(version ? { apiVersion: version } : {}),
      ...(link === "on" ? { customerKey: setting(env, "CUSTOMER_REF_KEY")! } : {}),
    });
  },
} satisfies ConnectorFactory;
