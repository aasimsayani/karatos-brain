import type { SandboxCheck } from "@karatos/core";
import { lightspeedConnector, memoryTokenStore } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A Lightspeed X-Series trial store connected to a test developer app with the read scopes only, never a client's store.
// Lightspeed replaces the refresh token on each refresh and the run can't save the new one, so the secret needs
// updating after every run; until a way to store it exists, expect this check to fail on its second run, as Xero's does.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "lightspeed",
  name: "Lightspeed Retail (X-Series)",
  credentials: ["SANDBOX_LIGHTSPEED_DOMAIN_PREFIX", "SANDBOX_LIGHTSPEED_CLIENT_ID", "SANDBOX_LIGHTSPEED_CLIENT_SECRET", "SANDBOX_LIGHTSPEED_REFRESH_TOKEN"],
  connector: (c) =>
    lightspeedConnector({
      domainPrefix: c.SANDBOX_LIGHTSPEED_DOMAIN_PREFIX!,
      clientId: c.SANDBOX_LIGHTSPEED_CLIENT_ID!,
      clientSecret: c.SANDBOX_LIGHTSPEED_CLIENT_SECRET!,
      customerKey: randomBytes(32).toString("hex"),
      tokens: memoryTokenStore(c.SANDBOX_LIGHTSPEED_REFRESH_TOKEN!),
      historyYears: 1,
    }),
} satisfies SandboxCheck;
