import { smileConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["SMILE_API_KEY", "CUSTOMER_REF_KEY"]),
  make: async (env) => smileConnector({ apiKey: setting(env, "SMILE_API_KEY")!, customerKey: setting(env, "CUSTOMER_REF_KEY")! }),
} satisfies ConnectorFactory;
