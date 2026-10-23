import type { SandboxCheck } from "@karatos/core";
import { stripeConnector } from "@karatos/connectors";

// A Stripe account in test mode, with a restricted key holding read permissions only.
export default {
  integration: "stripe",
  name: "Stripe",
  credentials: ["SANDBOX_STRIPE_SECRET_KEY"],
  connector: (c) => stripeConnector({ secretKey: c.SANDBOX_STRIPE_SECRET_KEY! }),
} satisfies SandboxCheck;
