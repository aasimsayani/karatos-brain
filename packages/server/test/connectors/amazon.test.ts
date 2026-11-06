import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = { AMAZON_SP_CLIENT_ID: `amzn1.application-oa2-client.${"a".repeat(32)}`, AMAZON_SP_CLIENT_SECRET: "s".repeat(64), AMAZON_SP_REFRESH_TOKEN: `Atzr|${"r".repeat(60)}` };

describe("the Amazon factory", () => {
  it("names the settings it is missing, never a value", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("amazon", { AMAZON_SP_CLIENT_SECRET: secret })).toBe("missing AMAZON_SP_CLIENT_ID, AMAZON_SP_REFRESH_TOKEN");
    expect(skipReason("amazon", { AMAZON_SP_CLIENT_SECRET: secret })).not.toContain(secret);
    expect(skipReason("amazon", { ...SETTINGS, AMAZON_SP_CLIENT_SECRET: "" })).toBe("missing AMAZON_SP_CLIENT_SECRET");
    expect(skipReason("amazon", SETTINGS)).toBeNull();
  });

  it("builds the connector from its settings, the marketplace, region and environment being optional", async () => {
    await buildsFromSettings("amazon", SETTINGS);
    await buildsFromSettings("amazon", { ...SETTINGS, AMAZON_SP_MARKETPLACE_ID: "A1PA6795UKMFR9", AMAZON_SP_REGION: "eu", AMAZON_SP_ENVIRONMENT: "sandbox" });
  });

  it("won't build with a bad client id, marketplace, region or environment", async () => {
    await expect(buildsFromSettings("amazon", { ...SETTINGS, AMAZON_SP_CLIENT_ID: "client" })).rejects.toThrow("AMAZON_SP_CLIENT_ID must be the app's LWA client id");
    await expect(buildsFromSettings("amazon", { ...SETTINGS, AMAZON_SP_MARKETPLACE_ID: "us" })).rejects.toThrow("AMAZON_SP_MARKETPLACE_ID must be a marketplace id");
    await expect(buildsFromSettings("amazon", { ...SETTINGS, AMAZON_SP_REGION: "us" })).rejects.toThrow("AMAZON_SP_REGION must be na, eu or fe");
    await expect(buildsFromSettings("amazon", { ...SETTINGS, AMAZON_SP_ENVIRONMENT: "staging" })).rejects.toThrow("AMAZON_SP_ENVIRONMENT must be production or sandbox");
  });
});
