import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { TAXJAR_API_TOKEN: "t".repeat(32), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the TaxJar factory", () => {
  it("names the settings it is missing, never a value", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("taxjar", { TAXJAR_API_TOKEN: secret })).toBe("missing CUSTOMER_REF_KEY");
    expect(skipReason("taxjar", { TAXJAR_API_TOKEN: secret })).not.toContain(secret);
    expect(skipReason("taxjar", { CUSTOMER_REF_KEY: "c".repeat(64) })).toBe("missing TAXJAR_API_TOKEN");
    expect(skipReason("taxjar", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with or without the optional ones", async () => {
    await buildsFromSettings("taxjar", SETTINGS);
    await buildsFromSettings("taxjar", { ...SETTINGS, TAXJAR_ENVIRONMENT: "sandbox", TAXJAR_PROVIDERS: "api, shopify,," });
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("taxjar", { ...SETTINGS, TAXJAR_API_TOKEN: "short" })).rejects.toThrow("TAXJAR_API_TOKEN is missing or not in the expected shape");
    await expect(buildsFromSettings("taxjar", { ...SETTINGS, TAXJAR_ENVIRONMENT: "live" })).rejects.toThrow("TAXJAR_ENVIRONMENT must be production or sandbox");
    await expect(buildsFromSettings("taxjar", { ...SETTINGS, TAXJAR_PROVIDERS: "api,Shopify" })).rejects.toThrow("TAXJAR_PROVIDERS must be lowercase source names");
  });
});
