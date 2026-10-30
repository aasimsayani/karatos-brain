import type { SandboxCheck } from "@karatos/core";
import { mailchimpConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Mailchimp account with one synthetic audience of example.test addresses and a test campaign sent to it.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "mailchimp",
  name: "Mailchimp",
  credentials: ["SANDBOX_MAILCHIMP_API_KEY"],
  connector: (c) => mailchimpConnector({ apiKey: c.SANDBOX_MAILCHIMP_API_KEY!, customerKey: randomBytes(32).toString("hex") }),
} satisfies SandboxCheck;
