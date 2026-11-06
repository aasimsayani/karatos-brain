import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Assembled at runtime so no key-shaped string sits in the repository.
const API_KEY = `${"a".repeat(32)}-us21`;
const CUSTOMER_KEY = "k".repeat(64);

describe("the Mailchimp factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("mailchimp", { MAILCHIMP_API_KEY: API_KEY });
    expect(reason).toBe("missing CUSTOMER_REF_KEY");
    expect(reason).not.toContain(API_KEY);
    expect(skipReason("mailchimp", {})).toBe("missing MAILCHIMP_API_KEY, CUSTOMER_REF_KEY");
  });

  it("builds the connector from the API key and the customer reference key", async () => {
    await buildsFromSettings("mailchimp", { MAILCHIMP_API_KEY: API_KEY, CUSTOMER_REF_KEY: CUSTOMER_KEY });
  });

  it("won't build with a key that doesn't name its data center", async () => {
    await expect(buildsFromSettings("mailchimp", { MAILCHIMP_API_KEY: "a".repeat(32), CUSTOMER_REF_KEY: CUSTOMER_KEY })).rejects.toThrow("MAILCHIMP_API_KEY must be a Mailchimp API key");
  });
});
