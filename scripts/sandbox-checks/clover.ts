import type { SandboxCheck } from "@karatos/core";
import { cloverConnector } from "@karatos/connectors";

// A Clover developer account's test merchant on the sandbox, with a merchant API token made in its dashboard
// holding the Read permissions only. Always the sandbox host. The token doesn't rotate, so the run keeps working.
// The customer key only has to be stable for the run; sandbox customers are synthetic.
export default {
  integration: "clover",
  name: "Clover",
  credentials: ["SANDBOX_CLOVER_MERCHANT_ID", "SANDBOX_CLOVER_API_TOKEN", "SANDBOX_CLOVER_CUSTOMER_REF_KEY"],
  connector: (c) =>
    cloverConnector({
      merchantId: c.SANDBOX_CLOVER_MERCHANT_ID!,
      region: "sandbox",
      auth: { apiToken: c.SANDBOX_CLOVER_API_TOKEN! },
      customerKey: c.SANDBOX_CLOVER_CUSTOMER_REF_KEY!,
    }),
} satisfies SandboxCheck;
