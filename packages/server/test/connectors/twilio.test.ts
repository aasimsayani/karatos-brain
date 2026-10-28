import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

// Assembled at runtime so no credential-shaped string sits in the repository.
const ENV = {
  TWILIO_ACCOUNT_SID: ["AC", "0".repeat(32)].join(""),
  TWILIO_API_KEY_SID: ["SK", "0".repeat(32)].join(""),
  TWILIO_API_KEY_SECRET: ["test", "0".repeat(28)].join(""),
  TWILIO_CONTACT_KEY: ["test", "contact", "key", "0".repeat(24)].join("-"),
};

describe("the Twilio factory", () => {
  it("names the settings it is missing, and never a value", () => {
    expect(skipReason("twilio", {})).toBe("missing TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_CONTACT_KEY");
    const { TWILIO_CONTACT_KEY: _, ...withoutKey } = ENV;
    const reason = skipReason("twilio", withoutKey);
    expect(reason).toBe("missing TWILIO_CONTACT_KEY");
    expect(reason).not.toContain(ENV.TWILIO_API_KEY_SECRET);
  });

  it("builds the connector from the account, the API key and the contact key", async () => {
    await buildsFromSettings("twilio", ENV);
  });

  it("turns down the account's Auth Token in place of an API key before reading anything", async () => {
    await expect(buildsFromSettings("twilio", { ...ENV, TWILIO_API_KEY_SID: ENV.TWILIO_ACCOUNT_SID })).rejects.toThrow("not the account SID");
  });
});
