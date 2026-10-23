import { affirmConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AFFIRM_PUBLIC_API_KEY", "AFFIRM_PRIVATE_API_KEY", "AFFIRM_MERCHANT_ID", "AFFIRM_ENVIRONMENT"]),
  make: async (env) =>
    affirmConnector({
      publicApiKey: setting(env, "AFFIRM_PUBLIC_API_KEY")!,
      privateApiKey: setting(env, "AFFIRM_PRIVATE_API_KEY")!,
      merchantId: setting(env, "AFFIRM_MERCHANT_ID")!,
      environment: setting(env, "AFFIRM_ENVIRONMENT")!,
    }),
} satisfies ConnectorFactory;
