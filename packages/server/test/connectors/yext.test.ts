import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { YEXT_API_KEY: "k".repeat(32) };

describe("the Yext factory", () => {
  it("names the setting it is missing, never a value", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("yext", { YEXT_ACCOUNT_ID: secret })).toBe("missing YEXT_API_KEY");
    expect(skipReason("yext", { YEXT_ACCOUNT_ID: secret })).not.toContain(secret);
    expect(skipReason("yext", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, the account and environment being optional", async () => {
    await buildsFromSettings("yext", SETTINGS);
    await buildsFromSettings("yext", { ...SETTINGS, YEXT_ACCOUNT_ID: "test-account", YEXT_ENVIRONMENT: "sandbox" });
  });

  it("won't build with a bad account or environment", async () => {
    await expect(buildsFromSettings("yext", { ...SETTINGS, YEXT_ACCOUNT_ID: "a/b" })).rejects.toThrow("YEXT_ACCOUNT_ID must be the account id Yext shows, or left unset");
    await expect(buildsFromSettings("yext", { ...SETTINGS, YEXT_ENVIRONMENT: "staging" })).rejects.toThrow("YEXT_ENVIRONMENT must be production or sandbox");
  });
});
