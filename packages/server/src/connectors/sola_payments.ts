import { solaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["SOLA_API_KEY", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    solaConnector({
      apiKey: setting(env, "SOLA_API_KEY")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      timeZone: setting(env, "SOLA_TIME_ZONE"),
    }),
} satisfies ConnectorFactory;
