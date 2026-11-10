import type { SandboxCheck } from "@karatos/core";
import { upsConnector } from "@karatos/connectors";

// A UPS test app's client id and secret, never a client's. They run against UPS's Customer
// Integration Environment, which only answers UPS's published test tracking numbers.
export const UPS_SANDBOX_NUMBERS = ["1Z12345E0205271688", "1Z12345E6605272234"];

export default {
  integration: "ups",
  name: "UPS Tracking",
  credentials: ["SANDBOX_UPS_CLIENT_ID", "SANDBOX_UPS_CLIENT_SECRET"],
  connector: (c) =>
    upsConnector({
      clientId: c.SANDBOX_UPS_CLIENT_ID!,
      clientSecret: c.SANDBOX_UPS_CLIENT_SECRET!,
      environment: "test",
      trackingNumbers: async () => UPS_SANDBOX_NUMBERS,
      maxPerSync: UPS_SANDBOX_NUMBERS.length,
    }),
} satisfies SandboxCheck;
