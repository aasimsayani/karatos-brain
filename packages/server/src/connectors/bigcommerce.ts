import { bigCommerceConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["BIGCOMMERCE_STORE_HASH", "BIGCOMMERCE_ACCESS_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    bigCommerceConnector({ storeHash: setting(env, "BIGCOMMERCE_STORE_HASH")!, accessToken: setting(env, "BIGCOMMERCE_ACCESS_TOKEN")!, customerKey: setting(env, "CUSTOMER_REF_KEY")! }),
} satisfies ConnectorFactory;
