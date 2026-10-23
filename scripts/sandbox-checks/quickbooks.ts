import type { SandboxCheck } from "@karatos/core";
import { memoryTokenStore, quickBooksConnector } from "@karatos/connectors";

// An Intuit developer sandbox company and the app's Development keys. Always the sandbox API, whatever the token.
// The run can't save the token Intuit rotates to, so it keeps working only while the stored one does;
// when the run fails with invalid_grant, reconnect the sandbox company and update the secret.
export default {
  integration: "quickbooks",
  name: "QuickBooks Online",
  credentials: ["SANDBOX_QUICKBOOKS_CLIENT_ID", "SANDBOX_QUICKBOOKS_CLIENT_SECRET", "SANDBOX_QUICKBOOKS_REALM_ID", "SANDBOX_QUICKBOOKS_REFRESH_TOKEN"],
  connector: (c) =>
    quickBooksConnector({
      clientId: c.SANDBOX_QUICKBOOKS_CLIENT_ID!,
      clientSecret: c.SANDBOX_QUICKBOOKS_CLIENT_SECRET!,
      realmId: c.SANDBOX_QUICKBOOKS_REALM_ID!,
      environment: "sandbox",
      tokens: memoryTokenStore(c.SANDBOX_QUICKBOOKS_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
