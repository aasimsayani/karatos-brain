import { tiktokAdsConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["TIKTOK_ADS_ACCESS_TOKEN", "TIKTOK_ADS_ADVERTISER_ID"]),
  // An advertiser token doesn't expire unless it is revoked, so there is nothing to refresh or store.
  make: async (env) => tiktokAdsConnector({ accessToken: setting(env, "TIKTOK_ADS_ACCESS_TOKEN")!, advertiserId: setting(env, "TIKTOK_ADS_ADVERTISER_ID")!, environment: setting(env, "TIKTOK_ADS_ENVIRONMENT") }),
} satisfies ConnectorFactory;
