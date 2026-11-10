import { judgemeConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["JUDGEME_SHOP_DOMAIN", "JUDGEME_API_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    judgemeConnector({
      shopDomain: setting(env, "JUDGEME_SHOP_DOMAIN")!,
      apiToken: setting(env, "JUDGEME_API_TOKEN")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
