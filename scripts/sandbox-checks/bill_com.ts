import type { SandboxCheck } from "@karatos/core";
import { billComConnector } from "@karatos/connectors";

// A BILL sandbox developer app's client id and secret, made with accounting data access, never a client's.
// They run against BILL's sandbox organization.
export default {
  integration: "bill_com",
  name: "BILL bills, vendors and payments",
  credentials: ["SANDBOX_BILL_COM_CLIENT_ID", "SANDBOX_BILL_COM_CLIENT_SECRET"],
  connector: (c) => billComConnector({ clientId: c.SANDBOX_BILL_COM_CLIENT_ID!, clientSecret: c.SANDBOX_BILL_COM_CLIENT_SECRET!, environment: "sandbox", historyYears: 1 }),
} satisfies SandboxCheck;
