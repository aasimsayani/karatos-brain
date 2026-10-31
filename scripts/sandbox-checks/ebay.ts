import type { SandboxCheck } from "@karatos/core";
import { ebayConnector } from "@karatos/connectors";

// eBay's sandbox, with a sandbox app's keys and the refresh token of a sandbox test user who agreed to
// sell.fulfillment.readonly only. Sandbox orders exist only if the test user sold something there, so the read may be empty.
export default {
  integration: "ebay",
  name: "eBay",
  credentials: ["SANDBOX_EBAY_CLIENT_ID", "SANDBOX_EBAY_CLIENT_SECRET", "SANDBOX_EBAY_REFRESH_TOKEN"],
  connector: (c) => ebayConnector({ clientId: c.SANDBOX_EBAY_CLIENT_ID!, clientSecret: c.SANDBOX_EBAY_CLIENT_SECRET!, refreshToken: c.SANDBOX_EBAY_REFRESH_TOKEN!, environment: "sandbox" }),
} satisfies SandboxCheck;
