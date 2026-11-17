import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Shaped like a client ID and secret, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { AURORA_CLIENT_ID: ["test", "0".repeat(12)].join("-"), AURORA_CLIENT_SECRET: ["s", "0".repeat(31)].join("") };

describe("the Aurora Payments factory", () => {
  it("names the settings it is missing, never a value", () => {
    expect(skipReason("aurora_payments", { AURORA_CLIENT_SECRET: SETTINGS.AURORA_CLIENT_SECRET })).toBe("missing AURORA_CLIENT_ID");
    expect(skipReason("aurora_payments", { AURORA_CLIENT_ID: SETTINGS.AURORA_CLIENT_ID })).toBe("missing AURORA_CLIENT_SECRET");
    expect(skipReason("aurora_payments", { AURORA_CLIENT_ID: SETTINGS.AURORA_CLIENT_ID })).not.toContain(SETTINGS.AURORA_CLIENT_ID);
    expect(skipReason("aurora_payments", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, for production or the sandbox", async () => {
    expect((await buildsFromSettings("aurora_payments", SETTINGS)).source).toBe("aurora_payments");
    expect((await buildsFromSettings("aurora_payments", { ...SETTINGS, AURORA_ENVIRONMENT: " Sandbox " })).source).toBe("aurora_payments");
    expect((await buildsFromSettings("aurora_payments", { ...SETTINGS, AURORA_ENVIRONMENT: "" })).source).toBe("aurora_payments");
  });

  it("won't build with a setting in the wrong shape", async () => {
    await expect(buildsFromSettings("aurora_payments", { ...SETTINGS, AURORA_CLIENT_SECRET: "short" })).rejects.toThrow("AURORA_CLIENT_SECRET is missing or not in the expected shape");
    await expect(buildsFromSettings("aurora_payments", { ...SETTINGS, AURORA_ENVIRONMENT: "staging" })).rejects.toThrow("AURORA_ENVIRONMENT must be production or sandbox");
  });
});
