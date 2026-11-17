import { cin7Connector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["CIN7_ACCOUNT_ID", "CIN7_APPLICATION_KEY"]),
  make: async (env) => cin7Connector({ accountId: setting(env, "CIN7_ACCOUNT_ID")!, applicationKey: setting(env, "CIN7_APPLICATION_KEY")! }),
} satisfies ConnectorFactory;
