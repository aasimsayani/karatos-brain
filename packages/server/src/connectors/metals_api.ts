import { metalsApiConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

function historyDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("METALS_API_HISTORY_DAYS must be a whole number of days");
  return Number(value);
}

export default {
  needs: (env) => missing(env, ["METALS_API_KEY"]),
  make: async (env) => metalsApiConnector({ accessKey: setting(env, "METALS_API_KEY")!, historyDays: historyDays(setting(env, "METALS_API_HISTORY_DAYS")) }),
} satisfies ConnectorFactory;
