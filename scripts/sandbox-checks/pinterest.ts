import type { SandboxCheck } from "@karatos/core";
import { memoryTokenStore, pinterestConnector } from "@karatos/connectors";

// A test Pinterest business account connected to a developer app with boards:read, pins:read and user_accounts:read
// only. Pinterest's sandbox serves the Pin list but not analytics, so the check runs against the real API with a test account.
export default {
  integration: "pinterest",
  name: "Pinterest",
  credentials: ["SANDBOX_PINTEREST_CLIENT_ID", "SANDBOX_PINTEREST_CLIENT_SECRET", "SANDBOX_PINTEREST_REFRESH_TOKEN"],
  connector: (c) => pinterestConnector({ clientId: c.SANDBOX_PINTEREST_CLIENT_ID!, clientSecret: c.SANDBOX_PINTEREST_CLIENT_SECRET!, tokens: memoryTokenStore(c.SANDBOX_PINTEREST_REFRESH_TOKEN!) }),
} satisfies SandboxCheck;
