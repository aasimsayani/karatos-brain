import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { RAMP_CLIENT_ID: ["ramp", "id", "0".repeat(16)].join("_"), RAMP_CLIENT_SECRET: ["ramp", "sec", "0".repeat(24)].join("_") };

describe("the Ramp factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("ramp", { RAMP_CLIENT_SECRET: SETTINGS.RAMP_CLIENT_SECRET })).toBe("missing RAMP_CLIENT_ID");
    expect(skipReason("ramp", { RAMP_CLIENT_ID: SETTINGS.RAMP_CLIENT_ID })).toBe("missing RAMP_CLIENT_SECRET");
    expect(skipReason("ramp", { RAMP_CLIENT_ID: SETTINGS.RAMP_CLIENT_ID })).not.toContain(SETTINGS.RAMP_CLIENT_ID);
    expect(skipReason("ramp", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, for production or the sandbox", async () => {
    expect((await buildsFromSettings("ramp", SETTINGS)).source).toBe("ramp");
    expect((await buildsFromSettings("ramp", { ...SETTINGS, RAMP_ENVIRONMENT: "sandbox" })).source).toBe("ramp");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("ramp", { ...SETTINGS, RAMP_CLIENT_ID: "short" })).rejects.toThrow("RAMP_CLIENT_ID is missing or not in the expected shape");
    await expect(buildsFromSettings("ramp", { ...SETTINGS, RAMP_CLIENT_SECRET: "has spaces in it" })).rejects.toThrow("RAMP_CLIENT_SECRET is missing or not in the expected shape");
    await expect(buildsFromSettings("ramp", { ...SETTINGS, RAMP_ENVIRONMENT: "staging" })).rejects.toThrow("RAMP_ENVIRONMENT must be production or sandbox");
  });
});
