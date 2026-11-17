import type { SandboxCheck } from "@karatos/core";
import { metaConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A test Page owned by a Meta developer app still in development mode, holding only synthetic Messenger
// conversations, read with a Page access token from the app's developer. Instagram and WhatsApp aren't checked:
// WhatsApp has no history to read, and its webhooks can't be called from here, so the webhook settings are only
// placeholders made new each run, as is the customer key; nothing is kept.
export default {
  integration: "meta",
  name: "Instagram DMs, Facebook Messenger and WhatsApp Business",
  credentials: ["SANDBOX_META_PAGE_ID", "SANDBOX_META_PAGE_ACCESS_TOKEN"],
  connector: (c) =>
    metaConnector({
      pageId: c.SANDBOX_META_PAGE_ID!,
      pageAccessToken: c.SANDBOX_META_PAGE_ACCESS_TOKEN!,
      channels: ["messenger"],
      appSecret: randomBytes(16).toString("hex"),
      verifyToken: randomBytes(24).toString("base64url"),
      whatsappPhoneNumberId: "1",
      customerKey: randomBytes(32).toString("hex"),
    }),
} satisfies SandboxCheck;
