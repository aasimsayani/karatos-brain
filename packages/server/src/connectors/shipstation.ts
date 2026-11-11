import { shipStationConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["SHIPSTATION_API_KEY"]),
  make: async (env) => shipStationConnector({ apiKey: setting(env, "SHIPSTATION_API_KEY")! }),
} satisfies ConnectorFactory;
