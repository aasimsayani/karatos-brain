import { repairShoprConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["REPAIRSHOPR_API_TOKEN", "REPAIRSHOPR_SUBDOMAIN"]),
  make: async (env) => repairShoprConnector({ apiToken: setting(env, "REPAIRSHOPR_API_TOKEN")!, subdomain: setting(env, "REPAIRSHOPR_SUBDOMAIN")! }),
} satisfies ConnectorFactory;
