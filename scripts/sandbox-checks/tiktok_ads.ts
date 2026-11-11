import type { SandboxCheck } from "@karatos/core";
import { tiktokAdsConnector } from "@karatos/connectors";

// A sandbox advertiser made in the TikTok for Business Developers portal, read with its sandbox token from an app
// with read scopes only. Sandbox advertisers have no real delivery, so the report is empty or small.
export default {
  integration: "tiktok_ads",
  name: "TikTok Ads",
  credentials: ["SANDBOX_TIKTOK_ADS_ACCESS_TOKEN", "SANDBOX_TIKTOK_ADS_ADVERTISER_ID"],
  connector: (c) => tiktokAdsConnector({ accessToken: c.SANDBOX_TIKTOK_ADS_ACCESS_TOKEN!, advertiserId: c.SANDBOX_TIKTOK_ADS_ADVERTISER_ID!, environment: "sandbox" }),
} satisfies SandboxCheck;
