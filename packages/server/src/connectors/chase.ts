import { chaseAccountsFromDirectory, chaseConnector, chaseFormats } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["CHASE_IMPORT_MODE", "CHASE_MANUAL_IMPORT_DIR"]),
  make: async (env) =>
    chaseConnector({ accounts: await chaseAccountsFromDirectory(setting(env, "CHASE_MANUAL_IMPORT_DIR")!), formats: chaseFormats(env.CHASE_IMPORT_MODE) }),
} satisfies ConnectorFactory;
