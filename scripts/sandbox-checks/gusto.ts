import type { SandboxCheck } from "@karatos/core";
import { gustoConnector, memoryTokenStore } from "@karatos/connectors";

// A company in Gusto's demo environment (api.gusto-demo.com) with synthetic employees and processed payrolls,
// connected to a test app holding only payrolls:read. Gusto replaces the refresh token on each refresh and the
// run can't save the new one, so the secret needs updating after every run; until a way to store it exists,
// expect this check to fail with invalid_grant.
export default {
  integration: "gusto",
  name: "Gusto",
  credentials: ["SANDBOX_GUSTO_CLIENT_ID", "SANDBOX_GUSTO_CLIENT_SECRET", "SANDBOX_GUSTO_REDIRECT_URI", "SANDBOX_GUSTO_COMPANY_UUID", "SANDBOX_GUSTO_REFRESH_TOKEN"],
  connector: (c) =>
    gustoConnector({
      clientId: c.SANDBOX_GUSTO_CLIENT_ID!,
      clientSecret: c.SANDBOX_GUSTO_CLIENT_SECRET!,
      redirectUri: c.SANDBOX_GUSTO_REDIRECT_URI!,
      companyUuid: c.SANDBOX_GUSTO_COMPANY_UUID!,
      environment: "demo",
      tokens: memoryTokenStore(c.SANDBOX_GUSTO_REFRESH_TOKEN!),
    }),
} satisfies SandboxCheck;
