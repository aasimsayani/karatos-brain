import { billComConnector, type BillEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["BILL_CLIENT_ID", "BILL_CLIENT_SECRET"]),
  make: async (env) =>
    billComConnector({
      clientId: setting(env, "BILL_CLIENT_ID")!,
      clientSecret: setting(env, "BILL_CLIENT_SECRET")!,
      environment: setting(env, "BILL_ENVIRONMENT") as BillEnvironment | undefined,
    }),
} satisfies ConnectorFactory;
