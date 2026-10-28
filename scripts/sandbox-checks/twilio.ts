import { randomBytes } from "node:crypto";
import type { SandboxCheck } from "@karatos/core";
import { twilioConnector } from "@karatos/connectors";

// A Twilio trial account with a restricted API key holding only the message and call read permissions.
// The run's contact references only need to line up within the run, so its key is made fresh each time.
export default {
  integration: "twilio",
  name: "Twilio",
  credentials: ["SANDBOX_TWILIO_ACCOUNT_SID", "SANDBOX_TWILIO_API_KEY_SID", "SANDBOX_TWILIO_API_KEY_SECRET"],
  connector: (c) =>
    twilioConnector({
      accountSid: c.SANDBOX_TWILIO_ACCOUNT_SID!,
      apiKeySid: c.SANDBOX_TWILIO_API_KEY_SID!,
      apiKeySecret: c.SANDBOX_TWILIO_API_KEY_SECRET!,
      contactKey: randomBytes(32).toString("hex"),
      historyYears: 1,
    }),
} satisfies SandboxCheck;
