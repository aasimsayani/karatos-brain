import { trelloConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["TRELLO_API_KEY", "TRELLO_TOKEN"]),
  make: async (env) => trelloConnector({ key: setting(env, "TRELLO_API_KEY")!, token: setting(env, "TRELLO_TOKEN")! }),
} satisfies ConnectorFactory;
