import { idexConnector, idexFeeds } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["IDEX_API_KEY", "IDEX_API_SECRET"]),
  make: async (env) =>
    idexConnector({
      apiKey: setting(env, "IDEX_API_KEY")!,
      apiSecret: setting(env, "IDEX_API_SECRET")!,
      feeds: idexFeeds(setting(env, "IDEX_FEEDS")),
      ...(setting(env, "IDEX_MAX_STONES") ? { maxStones: Number(setting(env, "IDEX_MAX_STONES")) } : {}),
    }),
} satisfies ConnectorFactory;
