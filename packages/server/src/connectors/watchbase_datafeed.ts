import { parseWatchbaseMaxWatches, watchbaseConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["WATCHBASE_API_KEY", "WATCHBASE_BRANDS"]),
  make: async (env) =>
    watchbaseConnector({
      apiKey: setting(env, "WATCHBASE_API_KEY")!,
      brands: setting(env, "WATCHBASE_BRANDS")!,
      maxWatches: parseWatchbaseMaxWatches(setting(env, "WATCHBASE_MAX_WATCHES")),
    }),
} satisfies ConnectorFactory;
