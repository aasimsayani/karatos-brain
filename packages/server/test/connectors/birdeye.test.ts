import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { BIRDEYE_API_KEY: "k".repeat(32), BIRDEYE_BUSINESS_ID: "100000001" };

describe("the Birdeye factory", () => {
  it("names the settings it is missing, never a value", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("birdeye", { BIRDEYE_API_KEY: secret })).toBe("missing BIRDEYE_BUSINESS_ID");
    expect(skipReason("birdeye", { BIRDEYE_API_KEY: secret })).not.toContain(secret);
    expect(skipReason("birdeye", { BIRDEYE_BUSINESS_ID: "1" })).toBe("missing BIRDEYE_API_KEY");
    expect(skipReason("birdeye", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("birdeye", SETTINGS);
  });

  it("won't build with a key or business id in the wrong shape", async () => {
    await expect(buildsFromSettings("birdeye", { ...SETTINGS, BIRDEYE_API_KEY: "short" })).rejects.toThrow("BIRDEYE_API_KEY is missing or not in the expected shape");
    await expect(buildsFromSettings("birdeye", { ...SETTINGS, BIRDEYE_BUSINESS_ID: "store-1" })).rejects.toThrow("BIRDEYE_BUSINESS_ID must be the business's numeric id");
  });
});
