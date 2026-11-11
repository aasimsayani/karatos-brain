import { trustpilotConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["TRUSTPILOT_API_KEY", "TRUSTPILOT_BUSINESS_UNIT_ID"]),
  make: async (env) =>
    trustpilotConnector({
      apiKey: setting(env, "TRUSTPILOT_API_KEY")!,
      businessUnitId: setting(env, "TRUSTPILOT_BUSINESS_UNIT_ID")!,
    }),
} satisfies ConnectorFactory;
