import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const klaviyoKey = ["pk", "testkey".repeat(4)].join("_");

describe("the Klaviyo factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("klaviyo", { KLAVIYO_PRIVATE_API_KEY: secret });
    expect(reason).toBe("missing CUSTOMER_REF_KEY");
    expect(reason).not.toContain(secret);
    const reason2 = skipReason("klaviyo", {});
    expect(reason2).toBe("missing KLAVIYO_PRIVATE_API_KEY, CUSTOMER_REF_KEY");
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("klaviyo", {
      KLAVIYO_PRIVATE_API_KEY: klaviyoKey,
      CUSTOMER_REF_KEY: "0".repeat(64),
      KLAVIYO_CONVERSION_METRIC_ID: "AbC123",
    });
  });

  it("builds without a conversion metric, which is optional", async () => {
    await buildsFromSettings("klaviyo", { KLAVIYO_PRIVATE_API_KEY: klaviyoKey, CUSTOMER_REF_KEY: "0".repeat(64) });
  });
});
