import { afterpayConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AFTERPAY_MERCHANT_ID", "AFTERPAY_SECRET_KEY", "AFTERPAY_ENVIRONMENT"]),
  make: async (env) =>
    afterpayConnector({
      merchantId: setting(env, "AFTERPAY_MERCHANT_ID")!,
      secretKey: setting(env, "AFTERPAY_SECRET_KEY")!,
      environment: setting(env, "AFTERPAY_ENVIRONMENT")!,
    }),
} satisfies ConnectorFactory;
