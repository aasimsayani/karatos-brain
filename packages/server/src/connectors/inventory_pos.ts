import { directorySource, inventoryPosConnector, resolvePosProfile } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["POS_IMPORT_DIR"]),
  make: async (env) =>
    inventoryPosConnector({ source: directorySource(setting(env, "POS_IMPORT_DIR")!), profile: await resolvePosProfile(env.POS_MAPPING_PROFILE) }),
} satisfies ConnectorFactory;
