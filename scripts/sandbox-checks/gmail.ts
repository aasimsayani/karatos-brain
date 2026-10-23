import type { SandboxCheck } from "@karatos/core";
import { gmailConnector, memoryTokenStore } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A Google account made for testing, holding only synthetic mail, connected to a test OAuth client with gmail.metadata only.
// Google has no Gmail sandbox. An External consent screen in Testing gives refresh tokens that expire after 7 days,
// so when the run fails with invalid_grant, reconnect the test account and update the secret.
// The correspondent key is new each run: nothing from the run is kept.
export default {
  integration: "gmail",
  name: "Gmail",
  credentials: ["SANDBOX_GMAIL_CLIENT_ID", "SANDBOX_GMAIL_CLIENT_SECRET", "SANDBOX_GMAIL_REFRESH_TOKEN"],
  connector: (c) =>
    gmailConnector({
      clientId: c.SANDBOX_GMAIL_CLIENT_ID!,
      clientSecret: c.SANDBOX_GMAIL_CLIENT_SECRET!,
      userId: "me",
      correspondentKey: randomBytes(32).toString("hex"),
      tokens: memoryTokenStore(c.SANDBOX_GMAIL_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
