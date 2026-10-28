import type { SandboxCheck } from "@karatos/core";
import { slackConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Slack developer sandbox workspace holding only synthetic messages, with an internal app whose bot
// holds channels:read, channels:history, groups:read and groups:history only, invited to the test channels.
// Text is kept for every channel so the redaction runs on live data; the key is new each run and nothing is kept.
// Slack can't be asked to send a test event, so there is no webhook step.
export default {
  integration: "slack",
  name: "Slack",
  credentials: ["SANDBOX_SLACK_BOT_TOKEN"],
  connector: (c) => slackConnector({ token: c.SANDBOX_SLACK_BOT_TOKEN!, correspondentKey: randomBytes(32).toString("hex"), textChannels: "all" }),
} satisfies SandboxCheck;
