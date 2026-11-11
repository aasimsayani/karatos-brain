import { nfusionConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["NFUSION_TOKEN"]),
  make: async (env) => nfusionConnector({ token: setting(env, "NFUSION_TOKEN")! }),
} satisfies ConnectorFactory;
