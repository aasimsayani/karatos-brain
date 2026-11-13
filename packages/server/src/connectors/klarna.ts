import { klarnaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  // A key alone, or a username with its password.
  needs: (env) => (setting(env, "KLARNA_API_KEY") ? [] : setting(env, "KLARNA_USERNAME") ? missing(env, ["KLARNA_PASSWORD"]) : ["KLARNA_API_KEY"]),
  make: async (env) =>
    klarnaConnector({
      // The connector trims each setting and reads a blank one as unset.
      apiKey: env.KLARNA_API_KEY,
      username: env.KLARNA_USERNAME,
      password: env.KLARNA_PASSWORD,
      region: env.KLARNA_REGION,
      environment: env.KLARNA_ENVIRONMENT,
    }),
} satisfies ConnectorFactory;
