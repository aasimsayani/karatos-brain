import { directorySource, fincen8300Connector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

const DATE_ORDERS = ["mdy", "dmy", "ymd"] as const;

export default {
  needs: (env) => missing(env, ["FINCEN_8300_IMPORT_DIR"]),
  make: async (env) => {
    const order = setting(env, "FINCEN_8300_DATE_ORDER") ?? "mdy";
    const dateOrder = DATE_ORDERS.find((o) => o === order);
    if (!dateOrder) throw new Error("FINCEN_8300_DATE_ORDER must be mdy, dmy or ymd");
    return fincen8300Connector({ source: directorySource(setting(env, "FINCEN_8300_IMPORT_DIR")!), dateOrder });
  },
} satisfies ConnectorFactory;
