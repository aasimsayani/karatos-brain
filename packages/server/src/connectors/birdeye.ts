import { birdeyeConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["BIRDEYE_API_KEY", "BIRDEYE_BUSINESS_ID"]),
  make: async (env) => birdeyeConnector({ apiKey: setting(env, "BIRDEYE_API_KEY")!, businessId: setting(env, "BIRDEYE_BUSINESS_ID")! }),
} satisfies ConnectorFactory;
