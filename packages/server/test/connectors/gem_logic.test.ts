import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// A key-shaped value, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { GEM_LOGIC_API_KEY: ["K", "0".repeat(32)].join("-"), GEM_LOGIC_INSTANCE: "example" };

describe("the Gem Logic factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("gem_logic", { GEM_LOGIC_INSTANCE: SETTINGS.GEM_LOGIC_INSTANCE })).toBe("missing GEM_LOGIC_API_KEY");
    expect(skipReason("gem_logic", { GEM_LOGIC_API_KEY: SETTINGS.GEM_LOGIC_API_KEY })).toBe("missing GEM_LOGIC_INSTANCE");
    expect(skipReason("gem_logic", { GEM_LOGIC_API_KEY: SETTINGS.GEM_LOGIC_API_KEY })).not.toContain(SETTINGS.GEM_LOGIC_API_KEY);
    expect(skipReason("gem_logic", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with the instance as a name, a host or a URL", async () => {
    expect((await buildsFromSettings("gem_logic", SETTINGS)).source).toBe("gem_logic");
    expect((await buildsFromSettings("gem_logic", { ...SETTINGS, GEM_LOGIC_INSTANCE: "https://Example.gem-logic.com/" })).source).toBe("gem_logic");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("gem_logic", { ...SETTINGS, GEM_LOGIC_API_KEY: "short" })).rejects.toThrow("GEM_LOGIC_API_KEY is missing or not in the expected shape");
    await expect(buildsFromSettings("gem_logic", { ...SETTINGS, GEM_LOGIC_INSTANCE: "example.gem-logic.example" })).rejects.toThrow("GEM_LOGIC_INSTANCE must be the business's instance, like example in example.gem-logic.com");
  });
});
