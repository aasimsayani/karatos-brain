import { rampConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET"]),
  make: async (env) =>
    rampConnector({
      clientId: setting(env, "RAMP_CLIENT_ID")!,
      clientSecret: setting(env, "RAMP_CLIENT_SECRET")!,
      environment: setting(env, "RAMP_ENVIRONMENT") as "production" | "sandbox" | undefined,
    }),
} satisfies ConnectorFactory;
