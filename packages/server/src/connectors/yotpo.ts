import { yotpoConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["YOTPO_STORE_ID", "YOTPO_API_SECRET", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    yotpoConnector({
      storeId: setting(env, "YOTPO_STORE_ID")!,
      apiSecret: setting(env, "YOTPO_API_SECRET")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      loyaltyGuid: setting(env, "YOTPO_LOYALTY_GUID"),
      loyaltyApiKey: setting(env, "YOTPO_LOYALTY_API_KEY"),
    }),
} satisfies ConnectorFactory;
