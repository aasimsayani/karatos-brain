import { giaConnector, giaReportNumbersFromFile } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["GIA_API_URL", "GIA_API_KEY", "GIA_REPORT_NUMBERS_FILE"]),
  make: async (env) =>
    giaConnector({
      apiUrl: setting(env, "GIA_API_URL")!,
      apiKey: setting(env, "GIA_API_KEY")!,
      reportNumbers: giaReportNumbersFromFile(setting(env, "GIA_REPORT_NUMBERS_FILE")!),
      ...(setting(env, "GIA_MAX_LOOKUPS_PER_SYNC") ? { maxLookups: Number(setting(env, "GIA_MAX_LOOKUPS_PER_SYNC")) } : {}),
    }),
} satisfies ConnectorFactory;
