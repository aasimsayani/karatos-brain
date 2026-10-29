import { calendlyConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["CALENDLY_ACCESS_TOKEN", "CUSTOMER_REF_KEY"]),
  make: async (env) => calendlyConnector({ token: setting(env, "CALENDLY_ACCESS_TOKEN")!, customerKey: setting(env, "CUSTOMER_REF_KEY")! }),
} satisfies ConnectorFactory;
