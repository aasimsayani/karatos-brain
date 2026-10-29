import { directorySource, piroConnector, resolvePiroProfile } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["PIRO_IMPORT_DIR"]),
  make: async (env) => piroConnector({ source: directorySource(setting(env, "PIRO_IMPORT_DIR")!), profile: await resolvePiroProfile(env.PIRO_MAPPING_PROFILE) }),
} satisfies ConnectorFactory;
