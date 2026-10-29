import { refinerStatementsConnector, refinersFromDirectory, resolveRefinerProfiles } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["REFINER_STATEMENTS_IMPORT_DIR"]),
  make: async (env) => {
    const profileFor = await resolveRefinerProfiles(env.REFINER_STATEMENTS_PROFILES);
    return refinerStatementsConnector({ refiners: await refinersFromDirectory(setting(env, "REFINER_STATEMENTS_IMPORT_DIR")!, profileFor) });
  },
} satisfies ConnectorFactory;
