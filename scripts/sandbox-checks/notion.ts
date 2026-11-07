import type { SandboxCheck } from "@karatos/core";
import { notionConnector } from "@karatos/connectors";

// A free Notion workspace for testing, with a database or two of synthetic pages shared with an internal connection that has only the Read content capability.
export default {
  integration: "notion",
  name: "Notion",
  credentials: ["SANDBOX_NOTION_ACCESS_TOKEN"],
  connector: (c) => notionConnector({ token: c.SANDBOX_NOTION_ACCESS_TOKEN! }),
} satisfies SandboxCheck;
