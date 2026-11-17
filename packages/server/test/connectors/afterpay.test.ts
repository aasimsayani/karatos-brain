import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Afterpay factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("sk", "live");
    const reason = skipReason("afterpay", { AFTERPAY_SECRET_KEY: secret });
    expect(reason).toBe("missing AFTERPAY_MERCHANT_ID, AFTERPAY_ENVIRONMENT");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("afterpay", { AFTERPAY_MERCHANT_ID: "600032000", AFTERPAY_SECRET_KEY: "secret-value-123", AFTERPAY_ENVIRONMENT: "sandbox" });
  });

  it("won't build for an environment that isn't production or sandbox", async () => {
    await expect(buildsFromSettings("afterpay", { AFTERPAY_MERCHANT_ID: "600032000", AFTERPAY_SECRET_KEY: "secret-value-123", AFTERPAY_ENVIRONMENT: "live" })).rejects.toThrow("AFTERPAY_ENVIRONMENT must be production or sandbox");
  });
});
