import { taxjarConnector, type TaxjarEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["TAXJAR_API_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env) => {
    const environment = setting(env, "TAXJAR_ENVIRONMENT");
    const providers = setting(env, "TAXJAR_PROVIDERS");
    return taxjarConnector({
      apiToken: setting(env, "TAXJAR_API_TOKEN")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      ...(environment ? { environment: environment as TaxjarEnvironment } : {}),
      ...(providers ? { providers: providers.split(",").map((p) => p.trim()).filter(Boolean) } : {}),
    });
  },
} satisfies ConnectorFactory;
