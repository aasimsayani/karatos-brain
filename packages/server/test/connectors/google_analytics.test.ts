import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Google Analytics 4 factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("google_analytics", { GOOGLE_CLIENT_SECRET: secret, GOOGLE_ANALYTICS_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing GOOGLE_CLIENT_ID, GOOGLE_ANALYTICS_PROPERTY_ID");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("google_analytics", {
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret-value",
      GOOGLE_ANALYTICS_REFRESH_TOKEN: "refresh-value",
      GOOGLE_ANALYTICS_PROPERTY_ID: "123456789",
    });
  });

  it("won't build for a property id that isn't a number", async () => {
    await expect(
      buildsFromSettings("google_analytics", { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "client-secret-value", GOOGLE_ANALYTICS_REFRESH_TOKEN: "refresh-value", GOOGLE_ANALYTICS_PROPERTY_ID: "G-TEST1234" }),
    ).rejects.toThrow("GOOGLE_ANALYTICS_PROPERTY_ID must be the property's numeric id");
  });
});
