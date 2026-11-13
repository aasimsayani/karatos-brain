import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// A token-shaped value, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { DEPUTY_ACCESS_TOKEN: ["dp", "0".repeat(32)].join("_"), DEPUTY_INSTALL: "example.na.deputy.com" };

describe("the Deputy factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("deputy", { DEPUTY_INSTALL: SETTINGS.DEPUTY_INSTALL })).toBe("missing DEPUTY_ACCESS_TOKEN");
    expect(skipReason("deputy", { DEPUTY_ACCESS_TOKEN: SETTINGS.DEPUTY_ACCESS_TOKEN })).toBe("missing DEPUTY_INSTALL");
    expect(skipReason("deputy", { DEPUTY_ACCESS_TOKEN: SETTINGS.DEPUTY_ACCESS_TOKEN })).not.toContain(SETTINGS.DEPUTY_ACCESS_TOKEN);
    expect(skipReason("deputy", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with the install as a host or a URL", async () => {
    expect((await buildsFromSettings("deputy", SETTINGS)).source).toBe("deputy");
    expect((await buildsFromSettings("deputy", { ...SETTINGS, DEPUTY_INSTALL: "https://Example.AU.deputy.com/" })).source).toBe("deputy");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("deputy", { ...SETTINGS, DEPUTY_ACCESS_TOKEN: "short" })).rejects.toThrow("DEPUTY_ACCESS_TOKEN is missing or not in the expected shape");
    await expect(buildsFromSettings("deputy", { ...SETTINGS, DEPUTY_INSTALL: "example.deputy.example" })).rejects.toThrow("DEPUTY_INSTALL must be the install's host, like example.na.deputy.com");
  });
});
