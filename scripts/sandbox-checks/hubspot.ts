import type { SandboxCheck } from "@karatos/core";
import { hubSpotConnector } from "@karatos/connectors";

// A free HubSpot developer test account with a private app holding the four read scopes only. The connector
// checks the token's scopes before reading and stops if any could change data.
export default {
  integration: "hubspot",
  name: "HubSpot",
  credentials: ["SANDBOX_HUBSPOT_ACCESS_TOKEN"],
  connector: (c) => hubSpotConnector({ accessToken: c.SANDBOX_HUBSPOT_ACCESS_TOKEN! }),
} satisfies SandboxCheck;
