import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Gmail factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("gmail", { GOOGLE_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing GOOGLE_CLIENT_ID, CORRESPONDENT_HASH_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("gmail", {
      GOOGLE_CLIENT_ID: "000000000000-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret-value",
      GMAIL_REFRESH_TOKEN: "refresh-value",
      GMAIL_USER: "owner@store.test",
      GMAIL_LABEL_NAMES: "drop",
      CORRESPONDENT_HASH_KEY: "0".repeat(64),
    });
  });

  it("hands over CUSTOMER_REF_KEY when the instance has one, so a customer's email links with other systems", async () => {
    const env = {
      GOOGLE_CLIENT_ID: "000000000000-test.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret-value",
      GMAIL_REFRESH_TOKEN: "refresh-value",
      CORRESPONDENT_HASH_KEY: "0".repeat(64),
    };
    await buildsFromSettings("gmail", { ...env, CUSTOMER_REF_KEY: "c".repeat(40) });
    await expect(buildsFromSettings("gmail", { ...env, CUSTOMER_REF_KEY: "short" })).rejects.toThrow("CUSTOMER_REF_KEY must be at least 32 characters");
  });
});
