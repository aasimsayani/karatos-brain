import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { EBAY_CLIENT_ID: `TestStor-KaratOS-PRD-${"a".repeat(9)}`, EBAY_CLIENT_SECRET: `PRD-${"s".repeat(24)}`, EBAY_REFRESH_TOKEN: `v^1.1#i^1#${"r".repeat(40)}` };

describe("the eBay factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("ebay", { EBAY_CLIENT_ID: "x", EBAY_CLIENT_SECRET: secret })).toBe("missing EBAY_REFRESH_TOKEN");
    expect(skipReason("ebay", { EBAY_REFRESH_TOKEN: secret })).toBe("missing EBAY_CLIENT_ID, EBAY_CLIENT_SECRET");
    expect(skipReason("ebay", { EBAY_CLIENT_ID: "x", EBAY_CLIENT_SECRET: secret })).not.toContain(secret);
  });

  it("builds the connector from its settings, for production or the sandbox", async () => {
    await buildsFromSettings("ebay", SETTINGS);
    await buildsFromSettings("ebay", { ...SETTINGS, EBAY_ENVIRONMENT: "sandbox" });
  });

  it("won't build for an environment that isn't production or sandbox", async () => {
    await expect(buildsFromSettings("ebay", { ...SETTINGS, EBAY_ENVIRONMENT: "live" })).rejects.toThrow("EBAY_ENVIRONMENT must be production or sandbox");
  });
});
