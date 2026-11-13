import type { SandboxCheck } from "@karatos/core";
import { klarnaConnector } from "@karatos/connectors";

// A key from a Klarna playground account (free to sign up for, North America), klarna_test_api_…, never a business's live key.
// The connector turns down a live key for the playground.
export default {
  integration: "klarna",
  name: "Klarna",
  credentials: ["SANDBOX_KLARNA_API_KEY"],
  connector: (c) => klarnaConnector({ apiKey: c.SANDBOX_KLARNA_API_KEY!, environment: "playground", region: "na" }),
} satisfies SandboxCheck;
