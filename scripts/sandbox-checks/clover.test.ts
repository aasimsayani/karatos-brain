import { describe, expect, it, vi } from "vitest";
import clover from "./clover.js";

describe("the Clover sandbox check", () => {
  it("builds the Clover connector against the sandbox host only, with the test merchant's API token", async () => {
    expect(clover.credentials).toEqual(["SANDBOX_CLOVER_MERCHANT_ID", "SANDBOX_CLOVER_API_TOKEN", "SANDBOX_CLOVER_CUSTOMER_REF_KEY"]);
    const sent: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ message: "stop" }), { status: 400 });
    });
    try {
      const connector = clover.connector({ SANDBOX_CLOVER_MERCHANT_ID: "MTEST0000000A", SANDBOX_CLOVER_API_TOKEN: "test-token", SANDBOX_CLOVER_CUSTOMER_REF_KEY: "k".repeat(64) });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Clover answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://apisandbox.dev.clover.com/v3/merchants/MTEST0000000A", method: "GET", auth: "Bearer test-token" }]);
  });;
});
