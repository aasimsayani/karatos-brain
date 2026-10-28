import { wooCommerceConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["WOOCOMMERCE_STORE_URL", "WOOCOMMERCE_CONSUMER_KEY", "WOOCOMMERCE_CONSUMER_SECRET", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    wooCommerceConnector({
      storeUrl: setting(env, "WOOCOMMERCE_STORE_URL")!,
      consumerKey: setting(env, "WOOCOMMERCE_CONSUMER_KEY")!,
      consumerSecret: setting(env, "WOOCOMMERCE_CONSUMER_SECRET")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
