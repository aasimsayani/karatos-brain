import type { SandboxCheck } from "@karatos/core";
import { authorizeNetConnector } from "@karatos/connectors";

// A free Authorize.net sandbox account (developer.authorize.net), never a merchant's. Always the sandbox endpoint.
// Its key could create test transactions; the client sends reporting requests only.
export default {
  integration: "authorize_net",
  name: "Authorize.net",
  credentials: ["SANDBOX_AUTHORIZE_NET_API_LOGIN_ID", "SANDBOX_AUTHORIZE_NET_TRANSACTION_KEY"],
  connector: (c) =>
    authorizeNetConnector({
      apiLoginId: c.SANDBOX_AUTHORIZE_NET_API_LOGIN_ID!,
      transactionKey: c.SANDBOX_AUTHORIZE_NET_TRANSACTION_KEY!,
      environment: "sandbox",
    }),
} satisfies SandboxCheck;
