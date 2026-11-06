import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

const SETTINGS = {
  GUSTO_CLIENT_ID: "client-id",
  GUSTO_CLIENT_SECRET: "client-secret-value",
  GUSTO_REDIRECT_URI: "https://brain.example.test/oauth/gusto",
  GUSTO_COMPANY_UUID: "00000000-0000-4000-8000-00000000c0c0",
  GUSTO_REFRESH_TOKEN: "refresh-value",
};

describe("the Gusto factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("gusto", { GUSTO_CLIENT_SECRET: secret, GUSTO_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing GUSTO_CLIENT_ID, GUSTO_REDIRECT_URI, GUSTO_COMPANY_UUID");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from the app's keys, the company and a refresh token, for production or the demo environment", async () => {
    await buildsFromSettings("gusto", SETTINGS);
    await buildsFromSettings("gusto", { ...SETTINGS, GUSTO_ENVIRONMENT: "demo" });
  });

  it("won't build for an environment Gusto doesn't have", async () => {
    await expect(buildsFromSettings("gusto", { ...SETTINGS, GUSTO_ENVIRONMENT: "staging" })).rejects.toThrow("GUSTO_ENVIRONMENT must be production or demo");
  });
});
