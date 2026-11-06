import type { SandboxCheck } from "@karatos/core";
import { trelloConnector } from "@karatos/connectors";

// A free Trello workspace for testing, with a board or two of synthetic cards, a Power-Up's API key, and a read-only token for a member who belongs only to it.
export default {
  integration: "trello",
  name: "Trello",
  credentials: ["SANDBOX_TRELLO_API_KEY", "SANDBOX_TRELLO_TOKEN"],
  connector: (c) => trelloConnector({ key: c.SANDBOX_TRELLO_API_KEY!, token: c.SANDBOX_TRELLO_TOKEN! }),
} satisfies SandboxCheck;
