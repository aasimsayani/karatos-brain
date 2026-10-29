import { describe, expect, it } from "vitest";
import { buildsFromSettings, skipReason } from "../connector-harness.js";

const token = ["calendly", "x".repeat(40)].join(".");

describe("the Calendly factory", () => {
  it("names the settings it is missing, never their values", () => {
    const reason = skipReason("calendly", { CALENDLY_ACCESS_TOKEN: token });
    expect(reason).toBe("missing CUSTOMER_REF_KEY");
    expect(reason).not.toContain(token);
    expect(skipReason("calendly", {})).toBe("missing CALENDLY_ACCESS_TOKEN, CUSTOMER_REF_KEY");
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("calendly", { CALENDLY_ACCESS_TOKEN: token, CUSTOMER_REF_KEY: "a".repeat(64) });
  });
});
