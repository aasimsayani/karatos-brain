import { zoomConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    zoomConnector({
      accountId: setting(env, "ZOOM_ACCOUNT_ID")!,
      clientId: setting(env, "ZOOM_CLIENT_ID")!,
      clientSecret: setting(env, "ZOOM_CLIENT_SECRET")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
