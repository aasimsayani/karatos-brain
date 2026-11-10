import { upsConnector, upsTrackingNumbersFromFile, type UpsEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["UPS_CLIENT_ID", "UPS_CLIENT_SECRET", "UPS_TRACKING_NUMBERS_FILE"]),
  make: async (env) => {
    const environment = setting(env, "UPS_ENVIRONMENT") as UpsEnvironment | undefined;
    return upsConnector({
      clientId: setting(env, "UPS_CLIENT_ID")!,
      clientSecret: setting(env, "UPS_CLIENT_SECRET")!,
      trackingNumbers: upsTrackingNumbersFromFile(setting(env, "UPS_TRACKING_NUMBERS_FILE")!),
      environment,
      ...(setting(env, "UPS_MAX_TRACKING_PER_SYNC") ? { maxPerSync: Number(setting(env, "UPS_MAX_TRACKING_PER_SYNC")) } : {}),
    });
  },
} satisfies ConnectorFactory;
