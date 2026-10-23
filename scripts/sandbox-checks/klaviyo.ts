import type { SandboxCheck } from "@karatos/core";
import { klaviyoConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Klaviyo test account, seeded with synthetic profiles, lists, a campaign and a flow, and a private key with read-only scopes.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "klaviyo",
  name: "Klaviyo",
  credentials: ["SANDBOX_KLAVIYO_PRIVATE_API_KEY"],
  connector: (c) => klaviyoConnector({ apiKey: c.SANDBOX_KLAVIYO_PRIVATE_API_KEY!, customerKey: randomBytes(32).toString("hex") }),
} satisfies SandboxCheck;
