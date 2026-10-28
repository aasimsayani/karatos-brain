import { describe, expect, it, vi } from "vitest";
import wix from "./wix.js";

describe("the Wix sandbox check", () => {
  it("builds the Wix connector from sandbox credentials only, stopping on a write permission before reading any data", async () => {
    expect(wix.credentials).toEqual(["SANDBOX_WIX_APP_ID", "SANDBOX_WIX_APP_SECRET", "SANDBOX_WIX_INSTANCE_ID"]);
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access-token-value", expires_in: 14_400 }), { status: 200 });
      return new Response(JSON.stringify({ instance: { permissions: ["SCOPE.DC-STORES.READ-ORDERS", "SCOPE.DC-STORES.MANAGE-PRODUCTS"] } }), { status: 200 });
    });
    const appSecret = ["app", "secret", "0".repeat(24)].join("-");
    try {
      const connector = wix.connector({ SANDBOX_WIX_APP_ID: "abcd0001-abcd-4abc-8def-abcdef000001", SANDBOX_WIX_APP_SECRET: appSecret, SANDBOX_WIX_INSTANCE_ID: "cafe0001-cafe-4abc-8def-abcdef000001" });
      expect(connector.source).toBe("wix");
      expect(connector.writes?.map((w) => w.name)).toEqual(["update_inventory", "update_product"]);
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("SCOPE.DC-STORES.MANAGE-PRODUCTS");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://www.wixapis.com/oauth2/token", "https://www.wixapis.com/apps/v1/instance"]);
    expect(sent[1]!.auth).toBe("test-access-token-value");
  });;
});
