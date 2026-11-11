import type { SandboxCheck } from "@karatos/core";
import { solaConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Sola Payments sandbox account (from solapayments.com/devsdk), with a few test-card sales, and its sandbox API key, never a merchant's live one.
// The key could run sandbox sales; the client posts Report:All to the reporting address only.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "sola_payments",
  name: "Sola Payments",
  credentials: ["SANDBOX_SOLA_PAYMENTS_API_KEY"],
  connector: (c) => solaConnector({ apiKey: c.SANDBOX_SOLA_PAYMENTS_API_KEY!, customerKey: randomBytes(32).toString("hex") }),
} satisfies SandboxCheck;
