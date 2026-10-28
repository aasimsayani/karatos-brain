import { klaviyoConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["KLAVIYO_PRIVATE_API_KEY", "CUSTOMER_REF_KEY"]),
  make: async (env) => {
    const metric = setting(env, "KLAVIYO_CONVERSION_METRIC_ID");
    return klaviyoConnector({ apiKey: setting(env, "KLAVIYO_PRIVATE_API_KEY")!, customerKey: setting(env, "CUSTOMER_REF_KEY")!, ...(metric ? { conversionMetricId: metric } : {}) });
  },
} satisfies ConnectorFactory;
