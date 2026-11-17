import { imapEmailConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["IMAP_HOST", "IMAP_USERNAME", "IMAP_PASSWORD", "CORRESPONDENT_HASH_KEY"]),
  make: async (env) => {
    const port = setting(env, "IMAP_PORT");
    return imapEmailConnector({
      host: setting(env, "IMAP_HOST")!,
      ...(port === undefined ? {} : { port }),
      username: setting(env, "IMAP_USERNAME")!,
      password: setting(env, "IMAP_PASSWORD")!,
      correspondentKey: setting(env, "CORRESPONDENT_HASH_KEY")!,
    });
  },
} satisfies ConnectorFactory;
