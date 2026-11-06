import type { SandboxCheck } from "@karatos/core";
import { asanaConnector } from "@karatos/connectors";

// A free Asana workspace for testing, with a project or two of synthetic tasks, and a personal access token made by a user who belongs only to it.
export default {
  integration: "asana",
  name: "Asana",
  credentials: ["SANDBOX_ASANA_ACCESS_TOKEN"],
  connector: (c) => asanaConnector({ token: c.SANDBOX_ASANA_ACCESS_TOKEN! }),
} satisfies SandboxCheck;
