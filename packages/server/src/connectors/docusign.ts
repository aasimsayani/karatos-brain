import { docusignConnector, type DocusignEnvironment } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["DOCUSIGN_INTEGRATION_KEY", "DOCUSIGN_USER_ID", "DOCUSIGN_ACCOUNT_ID", "DOCUSIGN_PRIVATE_KEY", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    docusignConnector({
      integrationKey: setting(env, "DOCUSIGN_INTEGRATION_KEY")!,
      userId: setting(env, "DOCUSIGN_USER_ID")!,
      accountId: setting(env, "DOCUSIGN_ACCOUNT_ID")!,
      privateKey: setting(env, "DOCUSIGN_PRIVATE_KEY")!,
      environment: (setting(env, "DOCUSIGN_ENVIRONMENT") ?? "production") as DocusignEnvironment,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
    }),
} satisfies ConnectorFactory;
