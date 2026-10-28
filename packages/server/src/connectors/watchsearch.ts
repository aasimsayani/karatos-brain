import { directorySource, watchSearchConnector, type ChatDateOrder } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

const DATE_ORDERS: readonly ChatDateOrder[] = ["auto", "dmy", "mdy"];

function dateOrder(value: string | undefined): ChatDateOrder {
  const order = (value?.trim() || "auto") as ChatDateOrder;
  if (!DATE_ORDERS.includes(order)) throw new Error("WATCHSEARCH_DATE_ORDER must be auto, dmy or mdy");
  return order;
}

export default {
  needs: (env) => missing(env, ["WATCHSEARCH_IMPORT_DIR", "WATCHSEARCH_DEALER_KEY"]),
  make: async (env) =>
    watchSearchConnector({
      source: directorySource(setting(env, "WATCHSEARCH_IMPORT_DIR")!),
      dealerKey: setting(env, "WATCHSEARCH_DEALER_KEY")!,
      dateOrder: dateOrder(env.WATCHSEARCH_DATE_ORDER),
      utcOffset: setting(env, "WATCHSEARCH_UTC_OFFSET"),
      defaultCurrency: setting(env, "WATCHSEARCH_CURRENCY"),
    }),
} satisfies ConnectorFactory;
