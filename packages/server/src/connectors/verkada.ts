import { verkadaConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["VERKADA_API_KEY"]),
  make: async (env) => {
    const region = setting(env, "VERKADA_REGION");
    return verkadaConnector({ apiKey: setting(env, "VERKADA_API_KEY")!, ...(region ? { region } : {}) });
  },
} satisfies ConnectorFactory;
