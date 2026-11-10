import type { SandboxCheck } from "@karatos/core";
import { fedexConnector } from "@karatos/connectors";

// A FedEx test project's API key and secret, never a client's. They run against FedEx's sandbox,
// which answers its own canned test tracking numbers.
export const FEDEX_SANDBOX_NUMBERS = ["123456789012", "111111111111"];

export default {
  integration: "fedex",
  name: "FedEx Track",
  credentials: ["SANDBOX_FEDEX_CLIENT_ID", "SANDBOX_FEDEX_CLIENT_SECRET"],
  connector: (c) =>
    fedexConnector({
      clientId: c.SANDBOX_FEDEX_CLIENT_ID!,
      clientSecret: c.SANDBOX_FEDEX_CLIENT_SECRET!,
      environment: "test",
      trackingNumbers: async () => FEDEX_SANDBOX_NUMBERS,
      maxPerSync: FEDEX_SANDBOX_NUMBERS.length,
    }),
} satisfies SandboxCheck;
