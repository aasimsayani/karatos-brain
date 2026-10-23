import type { SandboxCheck } from "@karatos/core";
import { mondayConnector } from "@karatos/connectors";

// A free monday.com developer account with a few test boards, read with a monday app's OAuth token
// granted boards:read and updates:read only, so monday.com itself refuses any change.
export default {
  integration: "monday",
  name: "Monday.com",
  credentials: ["SANDBOX_MONDAY_API_TOKEN"],
  connector: (c) => mondayConnector({ token: c.SANDBOX_MONDAY_API_TOKEN!, scopes: ["boards:read", "updates:read"] }),
} satisfies SandboxCheck;
