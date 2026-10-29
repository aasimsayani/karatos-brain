import type { SandboxCheck } from "@karatos/core";
import { avalaraConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free AvaTax sandbox account with a test company and a few synthetic committed sales.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "avalara",
  name: "Avalara AvaTax",
  credentials: ["SANDBOX_AVALARA_ACCOUNT_ID", "SANDBOX_AVALARA_LICENSE_KEY"],
  connector: (c) =>
    avalaraConnector({ accountId: c.SANDBOX_AVALARA_ACCOUNT_ID!, licenseKey: c.SANDBOX_AVALARA_LICENSE_KEY!, environment: "sandbox", customerKey: randomBytes(32).toString("hex") }),
} satisfies SandboxCheck;
