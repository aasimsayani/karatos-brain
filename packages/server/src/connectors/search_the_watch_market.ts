import { stwmConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["STWM_API_KEY", "STWM_REFERENCES"]),
  make: async (env) =>
    stwmConnector({
      apiKey: setting(env, "STWM_API_KEY")!,
      references: setting(env, "STWM_REFERENCES")!,
    }),
} satisfies ConnectorFactory;
