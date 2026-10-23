import type { SandboxCheck } from "@karatos/core";
import { plaidConnector } from "@karatos/connectors";

// A Plaid Sandbox Item, linked to one of Plaid's test banks with the transactions product only.
// Always the sandbox host, whatever the token, and the client stops on a token that names production.
export default {
  integration: "plaid",
  name: "Plaid",
  credentials: ["SANDBOX_PLAID_CLIENT_ID", "SANDBOX_PLAID_SECRET", "SANDBOX_PLAID_ACCESS_TOKEN"],
  connector: (c) =>
    plaidConnector({
      clientId: c.SANDBOX_PLAID_CLIENT_ID!,
      secret: c.SANDBOX_PLAID_SECRET!,
      accessToken: c.SANDBOX_PLAID_ACCESS_TOKEN!,
      environment: "sandbox",
    }),
} satisfies SandboxCheck;
