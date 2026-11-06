import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const TOKEN = `EAA${"t".repeat(60)}`;

describe("the Meta Ads factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    expect(skipReason("meta_ads", { META_ADS_ACCESS_TOKEN: secret })).toBe("missing META_ADS_ACCOUNT_ID");
    expect(skipReason("meta_ads", { META_ADS_ACCOUNT_ID: "act_1234567890" })).toBe("missing META_ADS_ACCESS_TOKEN");
    expect(skipReason("meta_ads", { META_ADS_ACCESS_TOKEN: secret })).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("meta_ads", { META_ADS_ACCESS_TOKEN: TOKEN, META_ADS_ACCOUNT_ID: "act_1234567890" });
  });

  it("won't build for an ad account id that isn't a number", async () => {
    await expect(buildsFromSettings("meta_ads", { META_ADS_ACCESS_TOKEN: TOKEN, META_ADS_ACCOUNT_ID: "my-store" })).rejects.toThrow("META_ADS_ACCOUNT_ID must be the ad account's numeric id");
  });
});
