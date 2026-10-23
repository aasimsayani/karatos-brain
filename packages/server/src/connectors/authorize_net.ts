import { authorizeNetConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AUTHORIZE_NET_API_LOGIN_ID", "AUTHORIZE_NET_TRANSACTION_KEY", "AUTHORIZE_NET_ENVIRONMENT"]),
  make: async (env) =>
    authorizeNetConnector({
      apiLoginId: setting(env, "AUTHORIZE_NET_API_LOGIN_ID")!,
      transactionKey: setting(env, "AUTHORIZE_NET_TRANSACTION_KEY")!,
      environment: setting(env, "AUTHORIZE_NET_ENVIRONMENT")!,
    }),
} satisfies ConnectorFactory;
