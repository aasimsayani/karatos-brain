import type { SandboxCheck } from "@karatos/core";
import { docusignConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Docusign developer account with a few envelopes of synthetic agreements sent to test addresses, and a JWT Grant app whose user has the Viewer permission profile.
// Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "docusign",
  name: "Docusign",
  credentials: ["SANDBOX_DOCUSIGN_INTEGRATION_KEY", "SANDBOX_DOCUSIGN_USER_ID", "SANDBOX_DOCUSIGN_ACCOUNT_ID", "SANDBOX_DOCUSIGN_PRIVATE_KEY"],
  connector: (c) =>
    docusignConnector({
      integrationKey: c.SANDBOX_DOCUSIGN_INTEGRATION_KEY!,
      userId: c.SANDBOX_DOCUSIGN_USER_ID!,
      accountId: c.SANDBOX_DOCUSIGN_ACCOUNT_ID!,
      privateKey: c.SANDBOX_DOCUSIGN_PRIVATE_KEY!,
      environment: "developer",
      customerKey: randomBytes(32).toString("hex"),
    }),
} satisfies SandboxCheck;
