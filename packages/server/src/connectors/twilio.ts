import { twilioConnector } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

const NAMES = ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_CONTACT_KEY"];

export default {
  needs: (env) => missing(env, NAMES),
  make: async (env) => {
    // CUSTOMER_REF_KEY isn't needed to read Twilio, but with it texts and calls link to the same customer in other systems.
    const customerKey = setting(env, "CUSTOMER_REF_KEY");
    return twilioConnector({
      accountSid: setting(env, "TWILIO_ACCOUNT_SID")!,
      apiKeySid: setting(env, "TWILIO_API_KEY_SID")!,
      apiKeySecret: setting(env, "TWILIO_API_KEY_SECRET")!,
      contactKey: setting(env, "TWILIO_CONTACT_KEY")!,
      ...(customerKey ? { customerKey } : {}),
    });
  },
} satisfies ConnectorFactory;
