import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { QUO_API_KEY: "q".repeat(32), CUSTOMER_REF_KEY: "c".repeat(64) };

describe("the Quo factory", () => {
  it("names the settings it is missing, never a value", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("openphone", { QUO_API_KEY: secret })).toBe("missing CUSTOMER_REF_KEY");
    expect(skipReason("openphone", { QUO_API_KEY: secret })).not.toContain(secret);
    expect(skipReason("openphone", { CUSTOMER_REF_KEY: "c".repeat(64) })).toBe("missing QUO_API_KEY");
    expect(skipReason("openphone", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("openphone", SETTINGS);
  });

  it("won't build with a key in the wrong shape", async () => {
    await expect(buildsFromSettings("openphone", { ...SETTINGS, QUO_API_KEY: "short" })).rejects.toThrow("QUO_API_KEY is missing or not in the expected shape");
    await expect(buildsFromSettings("openphone", { ...SETTINGS, CUSTOMER_REF_KEY: "short" })).rejects.toThrow("CUSTOMER_REF_KEY");
  });
});
