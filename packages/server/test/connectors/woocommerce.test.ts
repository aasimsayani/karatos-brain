import { describe, expect, it } from "vitest";
import { buildsFromSettings, fakeKey, skipReason } from "../connector-harness.js";

describe("the WooCommerce factory", () => {
  it("names the settings it is missing, never their values", () => {
    const secret = fakeKey("rk", "live");
    const reason = skipReason("woocommerce", { WOOCOMMERCE_STORE_URL: "https://shop.example.test", WOOCOMMERCE_CONSUMER_SECRET: secret });
    expect(reason).toBe("missing WOOCOMMERCE_CONSUMER_KEY, CUSTOMER_REF_KEY");
    expect(reason).not.toContain(secret);
  });

  it("builds the connector from its settings", async () => {
    await buildsFromSettings("woocommerce", {
      WOOCOMMERCE_STORE_URL: "https://shop.example.test",
      WOOCOMMERCE_CONSUMER_KEY: ["ck", "0".repeat(40)].join("_"),
      WOOCOMMERCE_CONSUMER_SECRET: ["cs", "0".repeat(40)].join("_"),
      CUSTOMER_REF_KEY: "0".repeat(64),
    });
  });
});
