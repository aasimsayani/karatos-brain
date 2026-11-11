import type { SandboxCheck } from "@karatos/core";
import { rampConnector } from "@karatos/connectors";

// An app in a Ramp sandbox (by request from Ramp), with the client credentials grant and transactions:read only, never a business's live app.
// The connector turns down a token granted any other scope.
export default {
  integration: "ramp",
  name: "Ramp",
  credentials: ["SANDBOX_RAMP_CLIENT_ID", "SANDBOX_RAMP_CLIENT_SECRET"],
  connector: (c) => rampConnector({ clientId: c.SANDBOX_RAMP_CLIENT_ID!, clientSecret: c.SANDBOX_RAMP_CLIENT_SECRET!, environment: "sandbox" }),
} satisfies SandboxCheck;
