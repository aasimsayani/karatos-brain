import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the Square factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("square", { SQUARE_APPLICATION_ID: "app", SQUARE_REFRESH_TOKEN: secret });
    expect(reason).toBe("missing CUSTOMER_REF_KEY, SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET, SQUARE_REFRESH_TOKEN");
    expect(reason).not.toContain(secret);
    const reason2 = skipReason("square", { SQUARE_ACCESS_TOKEN: secret });
    expect(reason2).toBe("missing CUSTOMER_REF_KEY");
    expect(reason2).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("square", {
      CUSTOMER_REF_KEY: "0".repeat(64),
      SQUARE_ENVIRONMENT: "sandbox",
      SQUARE_APPLICATION_ID: "sandbox-app-id",
      SQUARE_APPLICATION_SECRET: "app-secret-value",
      SQUARE_REFRESH_TOKEN: "refresh-value",
    });
  });
});
