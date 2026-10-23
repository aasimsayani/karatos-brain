import type { SandboxCheck } from "@karatos/core";
import { affirmConnector } from "@karatos/connectors";

// A free Affirm sandbox merchant account (its sandbox keys), never a merchant's live one. Always the sandbox host.
// Its keys could capture, refund and void sandbox loans; the client sends its listed GET reads only.
export default {
  integration: "affirm",
  name: "Affirm",
  credentials: ["SANDBOX_AFFIRM_PUBLIC_API_KEY", "SANDBOX_AFFIRM_PRIVATE_API_KEY", "SANDBOX_AFFIRM_MERCHANT_ID"],
  connector: (c) =>
    affirmConnector({
      publicApiKey: c.SANDBOX_AFFIRM_PUBLIC_API_KEY!,
      privateApiKey: c.SANDBOX_AFFIRM_PRIVATE_API_KEY!,
      merchantId: c.SANDBOX_AFFIRM_MERCHANT_ID!,
      environment: "sandbox",
    }),
} satisfies SandboxCheck;
