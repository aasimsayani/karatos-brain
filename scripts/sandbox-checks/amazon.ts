import type { SandboxCheck } from "@karatos/core";
import { amazonConnector } from "@karatos/connectors";

// A private SP-API app's LWA client and a refresh token from a sandbox authorization, run against Amazon's sandbox.
export default {
  integration: "amazon",
  name: "Amazon (Selling Partner API)",
  credentials: ["SANDBOX_AMAZON_SP_CLIENT_ID", "SANDBOX_AMAZON_SP_CLIENT_SECRET", "SANDBOX_AMAZON_SP_REFRESH_TOKEN"],
  connector: (c) =>
    amazonConnector({
      clientId: c.SANDBOX_AMAZON_SP_CLIENT_ID!,
      clientSecret: c.SANDBOX_AMAZON_SP_CLIENT_SECRET!,
      refreshToken: c.SANDBOX_AMAZON_SP_REFRESH_TOKEN!,
      environment: "sandbox",
    }),
} satisfies SandboxCheck;
