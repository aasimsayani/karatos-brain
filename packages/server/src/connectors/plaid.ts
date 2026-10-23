import { plaidConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ACCESS_TOKEN", "PLAID_ENVIRONMENT"]),
  make: async (env, store) =>
    plaidConnector({
      clientId: setting(env, "PLAID_CLIENT_ID")!,
      secret: setting(env, "PLAID_SECRET")!,
      accessToken: setting(env, "PLAID_ACCESS_TOKEN")!,
      environment: setting(env, "PLAID_ENVIRONMENT")!,
      // The first incremental pass carries on from the Plaid cursor the historical import ended on.
      ...(store ? { historicalCheckpoint: () => store.memory.getCheckpoint(store.organizationId, "plaid", "historical") } : {}),
    }),
} satisfies ConnectorFactory;
