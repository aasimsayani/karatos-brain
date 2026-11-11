import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const SETTINGS = { VERKADA_API_KEY: "k".repeat(32) };

describe("the Verkada factory", () => {
  it("names the setting it is missing, never a value, and doesn't need a region", () => {
    expect(skipReason("verkada", {})).toBe("missing VERKADA_API_KEY");
    expect(skipReason("verkada", { VERKADA_REGION: "eu" })).toBe("missing VERKADA_API_KEY");
    expect(skipReason("verkada", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, for either region, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("verkada", SETTINGS);
    await buildsFromSettings("verkada", { ...SETTINGS, VERKADA_REGION: "eu" });
    await expect(buildsFromSettings("verkada", { ...SETTINGS, VERKADA_REGION: "mars" })).rejects.toThrow(/VERKADA_REGION/);
    await expect(buildsFromSettings("verkada", { VERKADA_API_KEY: "short" })).rejects.toThrow(/VERKADA_API_KEY/);
  });
});
