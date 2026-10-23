import type { SandboxCheck } from "@karatos/core";
import { memoryTokenStore, xeroConnector } from "@karatos/connectors";

// Xero's Demo Company, connected to a test app with the read-only scopes. Xero has no separate sandbox API:
// the Demo Company is a throwaway organisation on the real API that Xero resets every 28 days.
// Xero retires the refresh token on each refresh and the run can't save the new one, so the secret needs
// updating after every run; until a way to store it exists, expect this check to fail with invalid_grant.
export default {
  integration: "xero",
  name: "Xero",
  credentials: ["SANDBOX_XERO_CLIENT_ID", "SANDBOX_XERO_CLIENT_SECRET", "SANDBOX_XERO_TENANT_ID", "SANDBOX_XERO_REFRESH_TOKEN"],
  connector: (c) =>
    xeroConnector({
      clientId: c.SANDBOX_XERO_CLIENT_ID!,
      clientSecret: c.SANDBOX_XERO_CLIENT_SECRET!,
      tenantId: c.SANDBOX_XERO_TENANT_ID!,
      tokens: memoryTokenStore(c.SANDBOX_XERO_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
