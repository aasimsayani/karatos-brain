import { notionConnector, parseNotionDataSources } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["NOTION_ACCESS_TOKEN"]),
  make: async (env) => notionConnector({ token: setting(env, "NOTION_ACCESS_TOKEN")!, dataSources: parseNotionDataSources(setting(env, "NOTION_DATA_SOURCE_IDS")) }),
} satisfies ConnectorFactory;
