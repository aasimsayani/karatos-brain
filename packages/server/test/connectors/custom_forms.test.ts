import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Custom forms factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("custom_forms", { TYPEFORM_ACCESS_TOKEN: secret, WEBHOOK_SIGNING_SECRET: secret });
    expect(reason).toBe("missing TYPEFORM_FORM_IDS, CUSTOMER_REF_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("custom_forms", {
      TYPEFORM_ACCESS_TOKEN: "typeform-token-value",
      TYPEFORM_FORM_IDS: "TestForm1, TestForm2",
      TYPEFORM_API_HOST: "api.eu.typeform.com",
      CUSTOMER_REF_KEY: "0".repeat(64),
    });
  });
});
