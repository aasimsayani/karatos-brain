import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { TRUSTPILOT_API_KEY: ["Tp", "0".repeat(24)].join(""), TRUSTPILOT_BUSINESS_UNIT_ID: ["5f0c0ffee", "0a0b0c0d0e0f", "0a1"].join("") };

describe("the Trustpilot factory", () => {
  it("names the settings it is missing, never a value", () => {
    const { TRUSTPILOT_API_KEY: key, ...rest } = SETTINGS;
    expect(skipReason("trustpilot", rest)).toBe("missing TRUSTPILOT_API_KEY");
    expect(skipReason("trustpilot", { TRUSTPILOT_API_KEY: key })).toBe("missing TRUSTPILOT_BUSINESS_UNIT_ID");
    expect(skipReason("trustpilot", { TRUSTPILOT_API_KEY: key })).not.toContain(key);
    expect(skipReason("trustpilot", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    expect((await buildsFromSettings("trustpilot", SETTINGS)).source).toBe("trustpilot");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("trustpilot", { ...SETTINGS, TRUSTPILOT_API_KEY: "short" })).rejects.toThrow("TRUSTPILOT_API_KEY is missing or not in the expected shape");
    await expect(buildsFromSettings("trustpilot", { ...SETTINGS, TRUSTPILOT_BUSINESS_UNIT_ID: "store.example.test" })).rejects.toThrow("TRUSTPILOT_BUSINESS_UNIT_ID is missing or not a business unit id");
  });
});
