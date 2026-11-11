import { gemLogicConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["GEM_LOGIC_API_KEY", "GEM_LOGIC_INSTANCE"]),
  make: async (env) => gemLogicConnector({ apiKey: setting(env, "GEM_LOGIC_API_KEY")!, instance: setting(env, "GEM_LOGIC_INSTANCE")! }),
} satisfies ConnectorFactory;
