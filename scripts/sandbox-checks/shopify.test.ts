import { describe, expect, it, vi } from "vitest";
import shopify from "./shopify.js";

describe("the Shopify sandbox check", () => {
  it("builds the Shopify connector from sandbox credentials only, signing in to the sandbox store with them", async () => {
    expect(shopify.credentials).toEqual(["SANDBOX_SHOPIFY_SHOP_DOMAIN", "SANDBOX_SHOPIFY_CLIENT_ID", "SANDBOX_SHOPIFY_CLIENT_SECRET"]);
    // The check builds its connector with the global fetch, so stub it to see what the connector sends.
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error: "stop_here" }), { status: 400 });
    });
    try {
      const connector = shopify.connector({ SANDBOX_SHOPIFY_SHOP_DOMAIN: "example-store.myshopify.com", SANDBOX_SHOPIFY_CLIENT_ID: "test-id", SANDBOX_SHOPIFY_CLIENT_SECRET: "test-secret" });
      expect(connector.source).toBe("shopify");
      const batches = connector.incrementalSync({ cursor: null } as Parameters<typeof connector.incrementalSync>[0]);
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://example-store.myshopify.com/admin/oauth/access_token");
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret")]).toEqual(["test-id", "test-secret"]);
  });
});
