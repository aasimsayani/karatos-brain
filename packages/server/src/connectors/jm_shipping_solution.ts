import { jmShippingConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["JM_SHIPPING_API_KEY", "JM_SHIPPING_PASSWORD", "JM_SHIPPING_CLIENT_ID"]),
  make: async (env) => {
    const apiBase = setting(env, "JM_SHIPPING_API_BASE");
    return jmShippingConnector({
      apiKey: setting(env, "JM_SHIPPING_API_KEY")!,
      password: setting(env, "JM_SHIPPING_PASSWORD")!,
      clientId: setting(env, "JM_SHIPPING_CLIENT_ID")!,
      ...(apiBase ? { apiBase } : {}),
    });
  },
} satisfies ConnectorFactory;
