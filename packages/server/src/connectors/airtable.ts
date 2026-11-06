import { airtableConnector, parseAirtableBases } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["AIRTABLE_ACCESS_TOKEN"]),
  make: async (env) => airtableConnector({ token: setting(env, "AIRTABLE_ACCESS_TOKEN")!, bases: parseAirtableBases(setting(env, "AIRTABLE_BASE_IDS")) }),
} satisfies ConnectorFactory;
