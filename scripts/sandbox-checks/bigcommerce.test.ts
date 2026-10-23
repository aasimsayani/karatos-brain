import { describe, expect, it, vi } from "vitest";
import bigcommerce from "./bigcommerce.js";

describe("the BigCommerce sandbox check", () => {
  it("builds the BigCommerce connector for the sandbox store, checking the store before any read and sending GETs only", async () => {
    expect(bigcommerce.credentials).toEqual(["SANDBOX_BIGCOMMERCE_STORE_HASH", "SANDBOX_BIGCOMMERCE_ACCESS_TOKEN"]);
    const sent: { url: string; method: string; token: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: String(init?.method), token: new Headers(init?.headers).get("x-auth-token") });
      return new Response(JSON.stringify({ status: 401, title: "stop" }), { status: 401 });
    });
    try {
      const connector = bigcommerce.connector({ SANDBOX_BIGCOMMERCE_STORE_HASH: "abc123def4", SANDBOX_BIGCOMMERCE_ACCESS_TOKEN: "test-token" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: "BigCommerceApiError", status: 401 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://api.bigcommerce.com/stores/abc123def4/v2/store", method: "GET", token: "test-token" }]);
  });;
});
