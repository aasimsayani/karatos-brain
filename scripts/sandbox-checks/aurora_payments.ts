import type { SandboxCheck } from "@karatos/core";
import { auroraConnector } from "@karatos/connectors";

// An API key from a Flute (Aurora Payments) sandbox account, free to sign up for, never a business's production key.
// A sandbox key is turned down by production, so the check can only reach the sandbox.
export default {
  integration: "aurora_payments",
  name: "Aurora Payments",
  credentials: ["SANDBOX_AURORA_CLIENT_ID", "SANDBOX_AURORA_CLIENT_SECRET"],
  connector: (c) => auroraConnector({ clientId: c.SANDBOX_AURORA_CLIENT_ID!, clientSecret: c.SANDBOX_AURORA_CLIENT_SECRET!, environment: "sandbox" }),
} satisfies SandboxCheck;
