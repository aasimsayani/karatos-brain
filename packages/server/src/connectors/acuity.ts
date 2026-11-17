import { acuityConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["ACUITY_USER_ID", "ACUITY_API_KEY", "CUSTOMER_REF_KEY"]),
  make: async (env) => acuityConnector({ userId: setting(env, "ACUITY_USER_ID")!, apiKey: setting(env, "ACUITY_API_KEY")!, customerKey: setting(env, "CUSTOMER_REF_KEY")! }),
} satisfies ConnectorFactory;
