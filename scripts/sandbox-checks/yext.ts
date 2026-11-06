import type { SandboxCheck } from "@karatos/core";
import { yextConnector } from "@karatos/connectors";

// An API key of an app in a Yext sandbox account, with read access to Entities and Reviews only.
export default {
  integration: "yext",
  name: "Yext",
  credentials: ["SANDBOX_YEXT_API_KEY"],
  connector: (c) => yextConnector({ apiKey: c.SANDBOX_YEXT_API_KEY!, environment: "sandbox" }),
} satisfies SandboxCheck;
