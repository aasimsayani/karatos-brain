import type { SandboxCheck } from "@karatos/core";
import { wixConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Wix dev site with Wix Stores, and a self-managed app holding read permissions only, installed on it.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "wix",
  name: "Wix",
  credentials: ["SANDBOX_WIX_APP_ID", "SANDBOX_WIX_APP_SECRET", "SANDBOX_WIX_INSTANCE_ID"],
  connector: (c) =>
    wixConnector({
      appId: c.SANDBOX_WIX_APP_ID!,
      appSecret: c.SANDBOX_WIX_APP_SECRET!,
      instanceId: c.SANDBOX_WIX_INSTANCE_ID!,
      customerKey: randomBytes(32).toString("hex"),
    }),
} satisfies SandboxCheck;
