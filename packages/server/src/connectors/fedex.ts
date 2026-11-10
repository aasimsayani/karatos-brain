import { fedexConnector, fedexTrackingNumbersFromFile, type FedexEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["FEDEX_CLIENT_ID", "FEDEX_CLIENT_SECRET", "FEDEX_TRACKING_NUMBERS_FILE"]),
  make: async (env) => {
    const environment = setting(env, "FEDEX_ENVIRONMENT") as FedexEnvironment | undefined;
    return fedexConnector({
      clientId: setting(env, "FEDEX_CLIENT_ID")!,
      clientSecret: setting(env, "FEDEX_CLIENT_SECRET")!,
      trackingNumbers: fedexTrackingNumbersFromFile(setting(env, "FEDEX_TRACKING_NUMBERS_FILE")!),
      environment,
      ...(setting(env, "FEDEX_MAX_TRACKING_PER_SYNC") ? { maxPerSync: Number(setting(env, "FEDEX_MAX_TRACKING_PER_SYNC")) } : {}),
    });
  },
} satisfies ConnectorFactory;
