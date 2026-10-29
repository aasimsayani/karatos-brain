import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const licenseKey = "x".repeat(16);
const settings = { AVALARA_ACCOUNT_ID: "2000000001", AVALARA_LICENSE_KEY: licenseKey, AVALARA_ENVIRONMENT: "sandbox", CUSTOMER_REF_KEY: "x".repeat(64) };

describe("the Avalara factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("avalara", { AVALARA_LICENSE_KEY: licenseKey });
    expect(reason).toBe("missing AVALARA_ACCOUNT_ID, AVALARA_ENVIRONMENT, CUSTOMER_REF_KEY");
    expect(reason).not.toContain(licenseKey);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("avalara", settings);
    await buildsFromSettings("avalara", { ...settings, AVALARA_COMPANY_CODE: "TESTSTORE" });
  });

  it("stops on an environment that isn't sandbox or production", async () => {
    await expect(buildsFromSettings("avalara", { ...settings, AVALARA_ENVIRONMENT: "staging" })).rejects.toThrow("AVALARA_ENVIRONMENT must be sandbox or production");
  });
});
