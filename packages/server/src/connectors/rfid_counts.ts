import { directorySource, rfidCountsConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

const DATE_ORDERS = ["mdy", "dmy", "ymd"] as const;

export default {
  needs: (env) => missing(env, ["RFID_COUNTS_IMPORT_DIR"]),
  make: async (env) => {
    const order = setting(env, "RFID_COUNTS_DATE_ORDER") ?? "mdy";
    const dateOrder = DATE_ORDERS.find((o) => o === order);
    if (!dateOrder) throw new Error("RFID_COUNTS_DATE_ORDER must be mdy, dmy or ymd");
    return rfidCountsConnector({ source: directorySource(setting(env, "RFID_COUNTS_IMPORT_DIR")!), dateOrder, utcOffset: setting(env, "RFID_COUNTS_UTC_OFFSET") ?? "Z" });
  },
} satisfies ConnectorFactory;
