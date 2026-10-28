import { directorySource, ediX12Connector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["EDI_IMPORT_DIR"]),
  make: async (env) => ediX12Connector({ source: directorySource(setting(env, "EDI_IMPORT_DIR")!) }),
} satisfies ConnectorFactory;
