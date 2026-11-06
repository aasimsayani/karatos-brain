import { yextConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["YEXT_API_KEY"]),
  // A Yext API key doesn't expire or rotate, so there is nothing to store.
  make: async (env) =>
    yextConnector({
      apiKey: setting(env, "YEXT_API_KEY")!,
      accountId: setting(env, "YEXT_ACCOUNT_ID"),
      environment: setting(env, "YEXT_ENVIRONMENT"),
    }),
} satisfies ConnectorFactory;
