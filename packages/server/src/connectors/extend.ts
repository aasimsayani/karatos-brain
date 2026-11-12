import { extendConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["EXTEND_CLIENT_ID", "EXTEND_CLIENT_SECRET", "EXTEND_STORE_ID"]),
  make: async (env) =>
    extendConnector({
      clientId: setting(env, "EXTEND_CLIENT_ID")!,
      clientSecret: setting(env, "EXTEND_CLIENT_SECRET")!,
      storeId: setting(env, "EXTEND_STORE_ID")!,
      environment: setting(env, "EXTEND_ENVIRONMENT") as "production" | "demo" | undefined,
    }),
} satisfies ConnectorFactory;
