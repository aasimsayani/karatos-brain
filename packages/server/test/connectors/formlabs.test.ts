import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like a client ID and secret, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { FORMLABS_CLIENT_ID: ["id", "0".repeat(20)].join("-"), FORMLABS_CLIENT_SECRET: ["s", "0".repeat(40)].join("") };

describe("the Formlabs factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("formlabs", { FORMLABS_CLIENT_SECRET: SETTINGS.FORMLABS_CLIENT_SECRET })).toBe("missing FORMLABS_CLIENT_ID");
    expect(skipReason("formlabs", { FORMLABS_CLIENT_ID: SETTINGS.FORMLABS_CLIENT_ID })).toBe("missing FORMLABS_CLIENT_SECRET");
    expect(skipReason("formlabs", { FORMLABS_CLIENT_ID: SETTINGS.FORMLABS_CLIENT_ID })).not.toContain(SETTINGS.FORMLABS_CLIENT_ID);
    expect(skipReason("formlabs", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    expect((await buildsFromSettings("formlabs", SETTINGS)).source).toBe("formlabs");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("formlabs", { ...SETTINGS, FORMLABS_CLIENT_ID: "short" })).rejects.toThrow("FORMLABS_CLIENT_ID is missing or not in the expected shape");
    await expect(buildsFromSettings("formlabs", { ...SETTINGS, FORMLABS_CLIENT_SECRET: "short" })).rejects.toThrow("FORMLABS_CLIENT_SECRET is missing or not in the expected shape");
  });
});
