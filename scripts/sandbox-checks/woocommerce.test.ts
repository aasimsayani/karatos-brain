import { describe, expect, it, vi } from "vitest";
import woo from "./woocommerce.js";

describe("the WooCommerce sandbox check", () => {
  it("builds the WooCommerce connector from sandbox credentials only, stopping on an http store before any request", async () => {
    expect(woo.credentials).toEqual(["SANDBOX_WOOCOMMERCE_STORE_URL", "SANDBOX_WOOCOMMERCE_CONSUMER_KEY", "SANDBOX_WOOCOMMERCE_CONSUMER_SECRET"]);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      sent.push(String(url));
      return new Response("[]", { status: 200 });
    });
    const key = ["ck", "0".repeat(40)].join("_");
    const secret = ["cs", "0".repeat(40)].join("_");
    try {
      const connector = woo.connector({ SANDBOX_WOOCOMMERCE_STORE_URL: "https://woo-sandbox.example.test", SANDBOX_WOOCOMMERCE_CONSUMER_KEY: key, SANDBOX_WOOCOMMERCE_CONSUMER_SECRET: secret });
      expect(connector.source).toBe("woocommerce");
      expect(connector.writes?.map((w) => w.name)).toEqual(["update_stock", "update_product"]);
      expect(() => woo.connector({ SANDBOX_WOOCOMMERCE_STORE_URL: "http://woo-sandbox.example.test", SANDBOX_WOOCOMMERCE_CONSUMER_KEY: key, SANDBOX_WOOCOMMERCE_CONSUMER_SECRET: secret })).toThrow("must start with https://");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([]);
  });;
});
