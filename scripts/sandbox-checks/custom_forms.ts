import type { SandboxCheck } from "@karatos/core";
import { customFormsConnector } from "@karatos/connectors";
import { randomBytes } from "node:crypto";

// A free Typeform account with one test form filled in with made-up answers, and a personal token holding
// forms:read and responses:read only. Each run makes its own customer reference key, as nothing it stores is kept.
export default {
  integration: "custom_forms",
  name: "Custom forms (Typeform)",
  credentials: ["SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN", "SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID"],
  connector: (c) =>
    customFormsConnector({
      forms: [c.SANDBOX_CUSTOM_FORMS_TYPEFORM_FORM_ID!],
      customerKey: randomBytes(32).toString("hex"),
      typeform: { accessToken: c.SANDBOX_CUSTOM_FORMS_TYPEFORM_TOKEN! },
    }),
} satisfies SandboxCheck;
