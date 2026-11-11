import { ringCentralConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["RINGCENTRAL_CLIENT_ID", "RINGCENTRAL_CLIENT_SECRET", "RINGCENTRAL_JWT", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    ringCentralConnector({
      clientId: setting(env, "RINGCENTRAL_CLIENT_ID")!,
      clientSecret: setting(env, "RINGCENTRAL_CLIENT_SECRET")!,
      jwt: setting(env, "RINGCENTRAL_JWT")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
