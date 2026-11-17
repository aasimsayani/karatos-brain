import { acumaticaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["ACUMATICA_URL", "ACUMATICA_CLIENT_ID", "ACUMATICA_CLIENT_SECRET", "ACUMATICA_USERNAME", "ACUMATICA_PASSWORD", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    acumaticaConnector({
      url: setting(env, "ACUMATICA_URL")!,
      clientId: setting(env, "ACUMATICA_CLIENT_ID")!,
      clientSecret: setting(env, "ACUMATICA_CLIENT_SECRET")!,
      username: setting(env, "ACUMATICA_USERNAME")!,
      password: setting(env, "ACUMATICA_PASSWORD")!,
      endpointVersion: setting(env, "ACUMATICA_ENDPOINT_VERSION"),
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
