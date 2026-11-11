import { klarnaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  // A key alone, or a username with its password.
  needs: (env) => (setting(env, "KLARNA_API_KEY") ? [] : setting(env, "KLARNA_USERNAME") ? missing(env, ["KLARNA_PASSWORD"]) : ["KLARNA_API_KEY"]),
  make: async (env) =>
    klarnaConnector({
      apiKey: setting(env, "KLARNA_API_KEY"),
      username: setting(env, "KLARNA_USERNAME"),
      password: setting(env, "KLARNA_PASSWORD"),
      region: setting(env, "KLARNA_REGION"),
      environment: setting(env, "KLARNA_ENVIRONMENT"),
    }),
} satisfies ConnectorFactory;
