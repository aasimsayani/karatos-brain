import { metaConnector, parseMetaChannels } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

// WHATSAPP_ACCESS_TOKEN and META_APP_ID are only for the declared writes and the app's setup; the read-only connector never sends them.
const NEEDS = ["META_PAGE_ID", "META_PAGE_ACCESS_TOKEN", "META_APP_SECRET", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "CUSTOMER_REF_KEY"];

/** Whether META_CHANNELS turns Instagram on; when it doesn't read, the connector names the problem as it is built. */
const instagramOn = (env: Parameters<typeof setting>[0]) => {
  try {
    return parseMetaChannels(setting(env, "META_CHANNELS")).includes("instagram");
  } catch {
    return false;
  }
};

export default {
  needs: (env) => missing(env, [...NEEDS, ...(instagramOn(env) ? ["META_INSTAGRAM_ACCOUNT_ID"] : [])]),
  make: async (env) => {
    const instagramAccountId = setting(env, "META_INSTAGRAM_ACCOUNT_ID");
    return metaConnector({
      pageId: setting(env, "META_PAGE_ID")!,
      pageAccessToken: setting(env, "META_PAGE_ACCESS_TOKEN")!,
      appSecret: setting(env, "META_APP_SECRET")!,
      verifyToken: setting(env, "WHATSAPP_VERIFY_TOKEN")!,
      whatsappPhoneNumberId: setting(env, "WHATSAPP_PHONE_NUMBER_ID")!,
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      channels: parseMetaChannels(setting(env, "META_CHANNELS")),
      ...(instagramAccountId ? { instagramAccountId } : {}),
    });
  },
} satisfies ConnectorFactory;
