import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Google Business Profile factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("google_business_profile", { GOOGLE_CLIENT_SECRET: secret, GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing GOOGLE_CLIENT_ID, GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("google_business_profile", {
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret-value",
      GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN: "refresh-value",
      GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID: "1234567890",
    });
  });

  it("won't build for an account id that isn't a number", async () => {
    await expect(
      buildsFromSettings("google_business_profile", { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "client-secret-value", GOOGLE_BUSINESS_PROFILE_REFRESH_TOKEN: "refresh-value", GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID: "accounts/123" }),
    ).rejects.toThrow("GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID must be the account's numeric id");
  });
});
