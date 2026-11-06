import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = {
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret-value",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-value",
  GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token-value",
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
};

describe("the Google Ads factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("google_ads", { GOOGLE_CLIENT_SECRET: secret, GOOGLE_ADS_REFRESH_TOKEN: secret, GOOGLE_ADS_DEVELOPER_TOKEN: secret });
    expect(reason).toBe("missing GOOGLE_CLIENT_ID, GOOGLE_ADS_CUSTOMER_ID");
    expect(reason).not.toContain(secret);
    const { GOOGLE_ADS_DEVELOPER_TOKEN: _token, ...noToken } = SETTINGS;
    expect(skipReason("google_ads", noToken)).toBe("missing GOOGLE_ADS_DEVELOPER_TOKEN");
  });

  it("builds the connector from its settings, with or without a manager account", async () => {
    await buildsFromSettings("google_ads", SETTINGS);
    await buildsFromSettings("google_ads", { ...SETTINGS, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "1112223333" });
  });

  it("won't build for a customer id that isn't 10 digits", async () => {
    await expect(buildsFromSettings("google_ads", { ...SETTINGS, GOOGLE_ADS_CUSTOMER_ID: "12345" })).rejects.toThrow("GOOGLE_ADS_CUSTOMER_ID must be the account's 10-digit customer id");
    await expect(buildsFromSettings("google_ads", { ...SETTINGS, GOOGLE_ADS_LOGIN_CUSTOMER_ID: "manager" })).rejects.toThrow("GOOGLE_ADS_LOGIN_CUSTOMER_ID must be");
  });
});
