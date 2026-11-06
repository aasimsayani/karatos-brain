import { describe, expect, it, vi } from "vitest";
import amazon from "./amazon.js";

describe("the Amazon sandbox check", () => {
  it("builds the Amazon connector against the SP-API sandbox, refreshing through Login with Amazon first", async () => {
    expect(amazon.credentials).toEqual(["SANDBOX_AMAZON_SP_CLIENT_ID", "SANDBOX_AMAZON_SP_CLIENT_SECRET", "SANDBOX_AMAZON_SP_REFRESH_TOKEN"]);
    const sent: { method: string; url: string; token: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ method: init?.method ?? "GET", url: String(url).split("?")[0]!, token: new Headers(init?.headers).get("x-amz-access-token") });
      if (String(url).startsWith("https://api.amazon.com/")) return new Response(JSON.stringify({ access_token: `Atza|${"t".repeat(40)}`, token_type: "bearer", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ errors: [{ code: "InvalidInput", message: "stop" }] }), { status: 400 });
    });
    try {
      const connector = amazon.connector({ SANDBOX_AMAZON_SP_CLIENT_ID: `amzn1.application-oa2-client.${"a".repeat(32)}`, SANDBOX_AMAZON_SP_CLIENT_SECRET: "s".repeat(64), SANDBOX_AMAZON_SP_REFRESH_TOKEN: `Atzr|${"r".repeat(60)}` });
      expect(connector.source).toBe("amazon");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Amazon answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([
      { method: "POST", url: "https://api.amazon.com/auth/o2/token", token: null },
      { method: "GET", url: "https://sandbox.sellingpartnerapi-na.amazon.com/orders/2026-01-01/orders", token: `Atza|${"t".repeat(40)}` },
    ]);
  });
});
