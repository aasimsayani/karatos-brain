import { slackConnector, slackDistribution, slackTextChannels } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  needs: (env) => missing(env, ["SLACK_BOT_TOKEN", "CORRESPONDENT_HASH_KEY"]),
  make: async (env) =>
    slackConnector({
      token: setting(env, "SLACK_BOT_TOKEN")!,
      correspondentKey: setting(env, "CORRESPONDENT_HASH_KEY")!,
      // No message text is kept unless the owner lists the channels, or says all.
      textChannels: slackTextChannels(env.SLACK_TEXT_CHANNELS),
      distribution: slackDistribution(env.SLACK_APP_DISTRIBUTION),
    }),
} satisfies ConnectorFactory;
