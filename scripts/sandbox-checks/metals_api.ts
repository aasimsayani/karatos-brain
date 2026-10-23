import type { SandboxCheck } from "@karatos/core";
import { metalsApiConnector } from "@karatos/connectors";

// A free Metals-API account's access key. A week of history keeps the nightly run to a handful of requests on the free plan's monthly allowance.
export default {
  integration: "metals_api",
  name: "Metals-API",
  credentials: ["SANDBOX_METALS_API_KEY"],
  connector: (c) => metalsApiConnector({ accessKey: c.SANDBOX_METALS_API_KEY!, historyDays: 7 }),
  minimumEvents: 4,
} satisfies SandboxCheck;
