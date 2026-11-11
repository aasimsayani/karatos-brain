import { netSuiteConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["NETSUITE_ACCOUNT_ID", "NETSUITE_CLIENT_ID", "NETSUITE_CERTIFICATE_ID", "NETSUITE_PRIVATE_KEY"]),
  make: async (env) =>
    netSuiteConnector({
      accountId: setting(env, "NETSUITE_ACCOUNT_ID")!,
      clientId: setting(env, "NETSUITE_CLIENT_ID")!,
      certificateId: setting(env, "NETSUITE_CERTIFICATE_ID")!,
      privateKey: setting(env, "NETSUITE_PRIVATE_KEY")!,
    }),
} satisfies ConnectorFactory;
