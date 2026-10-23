import { wixConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["WIX_APP_ID", "WIX_APP_SECRET", "WIX_INSTANCE_ID", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    wixConnector({
      appId: setting(env, "WIX_APP_ID")!,
      appSecret: setting(env, "WIX_APP_SECRET")!,
      instanceId: setting(env, "WIX_INSTANCE_ID")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
