import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const TOKEN = ["t", "0".repeat(39)].join("");

describe("the TikTok Ads factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("tiktok_ads", { TIKTOK_ADS_ACCESS_TOKEN: secret })).toBe("missing TIKTOK_ADS_ADVERTISER_ID");
    expect(skipReason("tiktok_ads", { TIKTOK_ADS_ADVERTISER_ID: "7000000000000000001" })).toBe("missing TIKTOK_ADS_ACCESS_TOKEN");
    expect(skipReason("tiktok_ads", { TIKTOK_ADS_ACCESS_TOKEN: secret })).not.toContain(secret);
  });

  it("builds the connector from its settings, in production or the sandbox", async () => {
    await buildsFromSettings("tiktok_ads", { TIKTOK_ADS_ACCESS_TOKEN: TOKEN, TIKTOK_ADS_ADVERTISER_ID: "7000000000000000001" });
    await buildsFromSettings("tiktok_ads", { TIKTOK_ADS_ACCESS_TOKEN: TOKEN, TIKTOK_ADS_ADVERTISER_ID: "7000000000000000001", TIKTOK_ADS_ENVIRONMENT: "Sandbox" });
  });

  it("won't build for an advertiser ID that isn't a number, or an environment it doesn't know", async () => {
    await expect(buildsFromSettings("tiktok_ads", { TIKTOK_ADS_ACCESS_TOKEN: TOKEN, TIKTOK_ADS_ADVERTISER_ID: "my-store" })).rejects.toThrow("TIKTOK_ADS_ADVERTISER_ID must be the advertiser's numeric ID");
    await expect(buildsFromSettings("tiktok_ads", { TIKTOK_ADS_ACCESS_TOKEN: TOKEN, TIKTOK_ADS_ADVERTISER_ID: "7000000000000000001", TIKTOK_ADS_ENVIRONMENT: "staging" })).rejects.toThrow("TIKTOK_ADS_ENVIRONMENT must be production or sandbox");
  });
});
