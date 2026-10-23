import { gmailConnector, memoryTokenStore } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";
import { sealedTokenStore } from "../token-store.js";

export default {
  needs: (env) => missing(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "CORRESPONDENT_HASH_KEY"]),
  make: async (env, store) => {
    const seed = setting(env, "GMAIL_REFRESH_TOKEN")!;
    const clientSecret = setting(env, "GOOGLE_CLIENT_SECRET")!;
    const labelNames = setting(env, "GMAIL_LABEL_NAMES");
    if (labelNames !== undefined && labelNames !== "keep" && labelNames !== "drop") throw new Error("GMAIL_LABEL_NAMES must be keep or drop");
    return gmailConnector({
      clientId: setting(env, "GOOGLE_CLIENT_ID")!,
      clientSecret,
      // One mailbox per instance: the account that connected, unless GMAIL_USER names it.
      userId: setting(env, "GMAIL_USER") ?? "me",
      correspondentKey: setting(env, "CORRESPONDENT_HASH_KEY")!,
      ...(labelNames ? { labelNames } : {}),
      // Google doesn't rotate refresh tokens, but one it ever returns is kept the same way as QuickBooks', sealed in the database.
      tokens: store ? sealedTokenStore({ ...store, source: "gmail", seed, keyMaterial: clientSecret }) : memoryTokenStore(seed),
    });
  },
} satisfies ConnectorFactory;
