import { outlookConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["MICROSOFT_TENANT_ID", "MICROSOFT_OUTLOOK_CLIENT_ID", "MICROSOFT_OUTLOOK_CLIENT_SECRET", "MICROSOFT_OUTLOOK_MAILBOX", "CORRESPONDENT_HASH_KEY"]),
  make: async (env) =>
    outlookConnector({
      tenantId: setting(env, "MICROSOFT_TENANT_ID")!,
      clientId: setting(env, "MICROSOFT_OUTLOOK_CLIENT_ID")!,
      clientSecret: setting(env, "MICROSOFT_OUTLOOK_CLIENT_SECRET")!,
      mailbox: setting(env, "MICROSOFT_OUTLOOK_MAILBOX")!,
      correspondentKey: setting(env, "CORRESPONDENT_HASH_KEY")!,
    }),
} satisfies ConnectorFactory;
