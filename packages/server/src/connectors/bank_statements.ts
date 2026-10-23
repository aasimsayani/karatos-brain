import { accountsFromDirectory, bankStatementsConnector, resolveBankProfiles } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["BANK_STATEMENTS_IMPORT_DIR"]),
  make: async (env) => {
    const profileFor = await resolveBankProfiles(env.BANK_STATEMENTS_PROFILES);
    return bankStatementsConnector({ accounts: await accountsFromDirectory(setting(env, "BANK_STATEMENTS_IMPORT_DIR")!, profileFor) });
  },
} satisfies ConnectorFactory;
