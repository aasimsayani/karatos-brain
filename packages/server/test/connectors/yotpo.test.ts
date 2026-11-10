import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Credential-shaped values, assembled at runtime so no scanner mistakes the source for a leak.
const SETTINGS = { YOTPO_STORE_ID: ["store", "0".repeat(10)].join(""), YOTPO_API_SECRET: ["secret", "0".repeat(24)].join(""), CUSTOMER_REF_KEY: "c".repeat(64) };
const LOYALTY = { YOTPO_LOYALTY_GUID: ["guid", "0".repeat(10)].join("_"), YOTPO_LOYALTY_API_KEY: ["lk", "0".repeat(20)].join("_") };

describe("the Yotpo factory", () => {
  it("names the settings it is missing, never a value", () => {
    const { YOTPO_API_SECRET: secret, ...rest } = SETTINGS;
    expect(skipReason("yotpo", rest)).toBe("missing YOTPO_API_SECRET");
    expect(skipReason("yotpo", { YOTPO_API_SECRET: secret })).toBe("missing YOTPO_STORE_ID, CUSTOMER_REF_KEY");
    expect(skipReason("yotpo", { YOTPO_API_SECRET: secret })).not.toContain(secret);
    expect(skipReason("yotpo", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, with or without Loyalty", async () => {
    expect((await buildsFromSettings("yotpo", SETTINGS)).source).toBe("yotpo");
    expect((await buildsFromSettings("yotpo", { ...SETTINGS, ...LOYALTY })).source).toBe("yotpo");
  });

  it("won't build with a setting in the wrong shape, or half of Loyalty", async () => {
    await expect(buildsFromSettings("yotpo", { ...SETTINGS, YOTPO_STORE_ID: "short" })).rejects.toThrow("YOTPO_STORE_ID is missing or not in the expected shape");
    await expect(buildsFromSettings("yotpo", { ...SETTINGS, YOTPO_API_SECRET: "short" })).rejects.toThrow("YOTPO_API_SECRET is missing or not in the expected shape");
    await expect(buildsFromSettings("yotpo", { ...SETTINGS, YOTPO_LOYALTY_GUID: LOYALTY.YOTPO_LOYALTY_GUID })).rejects.toThrow("go together");
    await expect(buildsFromSettings("yotpo", { ...SETTINGS, YOTPO_LOYALTY_API_KEY: LOYALTY.YOTPO_LOYALTY_API_KEY })).rejects.toThrow("go together");
    await expect(buildsFromSettings("yotpo", { ...SETTINGS, ...LOYALTY, YOTPO_LOYALTY_API_KEY: "bad key" })).rejects.toThrow("YOTPO_LOYALTY_API_KEY is not in the expected shape");
  });
});
