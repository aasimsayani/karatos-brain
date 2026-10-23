import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Affirm factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("affirm", { AFFIRM_PRIVATE_API_KEY: secret, AFFIRM_ENVIRONMENT: "sandbox" });
    expect(reason).toBe("missing AFFIRM_PUBLIC_API_KEY, AFFIRM_MERCHANT_ID");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("affirm", {
      // Shaped like Affirm's key pair, assembled so no scanner mistakes them for real ones.
      AFFIRM_PUBLIC_API_KEY: ["TESTPUB", "0".repeat(9)].join(""),
      AFFIRM_PRIVATE_API_KEY: ["TESTPRIV", "0".repeat(24)].join(""),
      AFFIRM_MERCHANT_ID: "MERCHANT-TEST",
      AFFIRM_ENVIRONMENT: "sandbox",
    });
  });
});
