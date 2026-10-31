import { describe, expect, it, vi } from "vitest";
import ebay from "./ebay.js";

describe("the eBay sandbox check", () => {
  it("builds the eBay connector for the sandbox, asking for the read scope alone", async () => {
    expect(ebay.credentials).toEqual(["SANDBOX_EBAY_CLIENT_ID", "SANDBOX_EBAY_CLIENT_SECRET", "SANDBOX_EBAY_REFRESH_TOKEN"]);
    const sent: { url: string; scope: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url).split("?")[0]!, scope: typeof init?.body === "string" ? new URLSearchParams(init.body).get("scope") : null });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "AT", expires_in: 7200 }), { status: 200 });
      return new Response(JSON.stringify({ errors: [{ errorId: 1, message: "stop" }] }), { status: 400 });
    });
    try {
      const connector = ebay.connector({ SANDBOX_EBAY_CLIENT_ID: `SBX-${"i".repeat(20)}`, SANDBOX_EBAY_CLIENT_SECRET: `SBX-${"s".repeat(24)}`, SANDBOX_EBAY_REFRESH_TOKEN: `v^1.1#${"r".repeat(40)}` });
      expect(connector.source).toBe("ebay");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("eBay answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([
      { url: "https://api.sandbox.ebay.com/identity/v1/oauth2/token", scope: "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly" },
      { url: "https://api.sandbox.ebay.com/sell/fulfillment/v1/order", scope: null },
    ]);
  });
});
