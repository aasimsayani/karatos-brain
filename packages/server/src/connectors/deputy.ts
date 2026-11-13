import { deputyConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["DEPUTY_ACCESS_TOKEN", "DEPUTY_INSTALL"]),
  make: async (env) => deputyConnector({ accessToken: setting(env, "DEPUTY_ACCESS_TOKEN")!, install: setting(env, "DEPUTY_INSTALL")! }),
} satisfies ConnectorFactory;
