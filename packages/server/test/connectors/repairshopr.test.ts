import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// A token-shaped value, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { REPAIRSHOPR_API_TOKEN: ["T", "0".repeat(32)].join("-"), REPAIRSHOPR_SUBDOMAIN: "example" };

describe("the RepairShopr factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("repairshopr", { REPAIRSHOPR_SUBDOMAIN: SETTINGS.REPAIRSHOPR_SUBDOMAIN })).toBe("missing REPAIRSHOPR_API_TOKEN");
    expect(skipReason("repairshopr", { REPAIRSHOPR_API_TOKEN: SETTINGS.REPAIRSHOPR_API_TOKEN })).toBe("missing REPAIRSHOPR_SUBDOMAIN");
    expect(skipReason("repairshopr", { REPAIRSHOPR_API_TOKEN: SETTINGS.REPAIRSHOPR_API_TOKEN })).not.toContain(SETTINGS.REPAIRSHOPR_API_TOKEN);
    expect(skipReason("repairshopr", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with the subdomain as a name, a host or a URL", async () => {
    expect((await buildsFromSettings("repairshopr", SETTINGS)).source).toBe("repairshopr");
    expect((await buildsFromSettings("repairshopr", { ...SETTINGS, REPAIRSHOPR_SUBDOMAIN: "https://Example.repairshopr.com/" })).source).toBe("repairshopr");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("repairshopr", { ...SETTINGS, REPAIRSHOPR_API_TOKEN: "short" })).rejects.toThrow("REPAIRSHOPR_API_TOKEN is missing or not in the expected shape");
    await expect(buildsFromSettings("repairshopr", { ...SETTINGS, REPAIRSHOPR_SUBDOMAIN: "example.repairshopr.example" })).rejects.toThrow("REPAIRSHOPR_SUBDOMAIN must be the account's subdomain, like example in example.repairshopr.com");
  });
});
