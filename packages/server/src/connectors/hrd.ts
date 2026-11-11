import { hrdConnector, hrdReportNumbersFromFile } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["HRD_API_TOKEN", "HRD_REPORT_NUMBERS_FILE"]),
  make: async (env) =>
    hrdConnector({
      apiToken: setting(env, "HRD_API_TOKEN")!,
      reportNumbers: hrdReportNumbersFromFile(setting(env, "HRD_REPORT_NUMBERS_FILE")!),
      ...(setting(env, "HRD_MAX_LOOKUPS_PER_SYNC") ? { maxLookups: Number(setting(env, "HRD_MAX_LOOKUPS_PER_SYNC")) } : {}),
    }),
} satisfies ConnectorFactory;
