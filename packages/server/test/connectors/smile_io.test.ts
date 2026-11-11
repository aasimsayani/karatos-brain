import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const SETTINGS = { SMILE_API_KEY: ["api", "test", "0".repeat(24)].join("_"), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the Smile.io factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("smile_io", {})).toBe("missing SMILE_API_KEY, CUSTOMER_REF_KEY");
    expect(skipReason("smile_io", { CUSTOMER_REF_KEY: SETTINGS.CUSTOMER_REF_KEY })).toBe("missing SMILE_API_KEY");
    expect(skipReason("smile_io", { SMILE_API_KEY: SETTINGS.SMILE_API_KEY })).not.toContain(SETTINGS.SMILE_API_KEY);
    expect(skipReason("smile_io", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("smile_io", SETTINGS);
    await expect(buildsFromSettings("smile_io", { ...SETTINGS, SMILE_API_KEY: "short" })).rejects.toThrow(/SMILE_API_KEY/);
    await expect(buildsFromSettings("smile_io", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow(/CUSTOMER_REF_KEY/);
  });
});
