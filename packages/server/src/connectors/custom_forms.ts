import { customFormsConnector, parseTypeformFormIds, resolveFormProfile } from "@karatos/connectors";
import { missing, setting, type ConnectorFactory } from "../connector-factory.js";

export default {
  // Typeform is read on a schedule; signed website submissions arrive by webhook only, so they need no sync.
  needs: (env) => missing(env, ["TYPEFORM_ACCESS_TOKEN", "TYPEFORM_FORM_IDS", "CUSTOMER_REF_KEY"]),
  make: async (env) =>
    customFormsConnector({
      forms: parseTypeformFormIds(setting(env, "TYPEFORM_FORM_IDS")),
      customerKey: setting(env, "CUSTOMER_REF_KEY")!,
      profile: await resolveFormProfile(env.FORMS_MAPPING_PROFILE),
      typeform: { accessToken: setting(env, "TYPEFORM_ACCESS_TOKEN")!, ...(setting(env, "TYPEFORM_API_HOST") ? { host: setting(env, "TYPEFORM_API_HOST")! } : {}) },
    }),
} satisfies ConnectorFactory;
