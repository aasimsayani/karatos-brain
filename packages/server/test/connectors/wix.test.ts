import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Wix factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("wix", { WIX_APP_ID: "id", WIX_APP_SECRET: secret });
    expect(reason).toBe("missing WIX_INSTANCE_ID, CUSTOMER_REF_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("wix", {
      WIX_APP_ID: "abcd0001-abcd-4abc-8def-abcdef000001",
      WIX_APP_SECRET: ["app", "secret", "0".repeat(24)].join("-"),
      WIX_INSTANCE_ID: "cafe0001-cafe-4abc-8def-abcdef000001",
      CUSTOMER_REF_KEY: "0".repeat(64),
    });
  });
});
