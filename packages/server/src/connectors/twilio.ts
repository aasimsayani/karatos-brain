import { twilioConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

const NAMES = ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_CONTACT_KEY"];

export default {
  needs: (env) => missing(env, NAMES),
  make: async (env) =>
    twilioConnector({
      accountSid: setting(env, "TWILIO_ACCOUNT_SID")!,
      apiKeySid: setting(env, "TWILIO_API_KEY_SID")!,
      apiKeySecret: setting(env, "TWILIO_API_KEY_SECRET")!,
      contactKey: setting(env, "TWILIO_CONTACT_KEY")!,
    }),
} satisfies ConnectorFactory;
