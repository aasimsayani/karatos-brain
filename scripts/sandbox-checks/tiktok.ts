import type { SandboxCheck } from "@karatos/core";
import { memoryTokenStore, tiktokConnector } from "@karatos/connectors";

// A test TikTok account connected to a developer app in sandbox mode with user.info.basic, user.info.stats and
// video.list only. The Display API serves a sandbox app's own test users, so the check reads that test account.
export default {
  integration: "tiktok",
  name: "TikTok",
  credentials: ["SANDBOX_TIKTOK_CLIENT_KEY", "SANDBOX_TIKTOK_CLIENT_SECRET", "SANDBOX_TIKTOK_REFRESH_TOKEN"],
  connector: (c) => tiktokConnector({ clientKey: c.SANDBOX_TIKTOK_CLIENT_KEY!, clientSecret: c.SANDBOX_TIKTOK_CLIENT_SECRET!, tokens: memoryTokenStore(c.SANDBOX_TIKTOK_REFRESH_TOKEN!) }),
} satisfies SandboxCheck;
