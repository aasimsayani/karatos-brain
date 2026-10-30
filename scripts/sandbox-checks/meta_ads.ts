import type { SandboxCheck } from "@karatos/core";
import { metaAdsConnector } from "@karatos/connectors";

// A sandbox ad account made from a Meta developer app (Marketing API > Tools), read with a system user token from a
// test business that holds ads_read only. Sandbox accounts have no real delivery, so the insights are empty or small.
export default {
  integration: "meta_ads",
  name: "Meta Ads",
  credentials: ["SANDBOX_META_ADS_ACCESS_TOKEN", "SANDBOX_META_ADS_ACCOUNT_ID"],
  connector: (c) => metaAdsConnector({ accessToken: c.SANDBOX_META_ADS_ACCESS_TOKEN!, accountId: c.SANDBOX_META_ADS_ACCOUNT_ID! }),
} satisfies SandboxCheck;
