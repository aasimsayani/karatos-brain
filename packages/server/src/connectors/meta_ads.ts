import { metaAdsConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["META_ADS_ACCESS_TOKEN", "META_ADS_ACCOUNT_ID"]),
  // A system user token doesn't expire, so there is nothing to refresh or store.
  make: async (env) => metaAdsConnector({ accessToken: setting(env, "META_ADS_ACCESS_TOKEN")!, accountId: setting(env, "META_ADS_ACCOUNT_ID")! }),
} satisfies ConnectorFactory;
