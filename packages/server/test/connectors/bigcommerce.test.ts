import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the BigCommerce factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("bigcommerce", { BIGCOMMERCE_ACCESS_TOKEN: secret });
    expect(reason).toBe("missing BIGCOMMERCE_STORE_HASH, CUSTOMER_REF_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("bigcommerce", {
      BIGCOMMERCE_STORE_HASH: "abc123def4",
      BIGCOMMERCE_ACCESS_TOKEN: "store-token-value",
      CUSTOMER_REF_KEY: "0".repeat(64),
    });
  });
});
