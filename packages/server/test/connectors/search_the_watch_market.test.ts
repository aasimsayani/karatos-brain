import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const SETTINGS = {
  STWM_API_KEY: "k".repeat(32),
  STWM_REFERENCES: "TEST-1, TEST-2",
};

describe("the Search The Watch Market factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("search_the_watch_market", {})).toBe("missing STWM_API_KEY, STWM_REFERENCES");
    expect(
      skipReason("search_the_watch_market", {
        STWM_API_KEY: SETTINGS.STWM_API_KEY,
      }),
    ).toBe("missing STWM_REFERENCES");
    expect(skipReason("search_the_watch_market", { STWM_REFERENCES: "TEST-1" })).toBe("missing STWM_API_KEY");
    expect(skipReason("search_the_watch_market", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, and won't for a setting that doesn't read", async () => {
    await buildsFromSettings("search_the_watch_market", SETTINGS);
    await expect(
      buildsFromSettings("search_the_watch_market", {
        ...SETTINGS,
        STWM_API_KEY: "short",
      }),
    ).rejects.toThrow(/STWM_API_KEY/);
    await expect(
      buildsFromSettings("search_the_watch_market", {
        ...SETTINGS,
        STWM_REFERENCES: "a,<b>",
      }),
    ).rejects.toThrow(/STWM_REFERENCES/);
  });
});
