import { nivodaConnector, nivodaEnvironment, nivodaQuery } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["NIVODA_USERNAME", "NIVODA_PASSWORD"]),
  make: async (env) =>
    nivodaConnector({
      username: setting(env, "NIVODA_USERNAME")!,
      password: setting(env, "NIVODA_PASSWORD")!,
      environment: nivodaEnvironment(setting(env, "NIVODA_ENVIRONMENT")),
      query: nivodaQuery(setting(env, "NIVODA_QUERY")),
      ...(setting(env, "NIVODA_MAX_STONES") ? { maxStones: Number(setting(env, "NIVODA_MAX_STONES")) } : {}),
    }),
} satisfies ConnectorFactory;
