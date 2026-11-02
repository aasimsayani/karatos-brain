import { describe, expect, it, vi } from "vitest";
import yext from "./yext.js";

describe("the Yext sandbox check", () => {
  it("builds the Yext connector against Yext's sandbox, with the key in a header", async () => {
    expect(yext.credentials).toEqual(["SANDBOX_YEXT_API_KEY"]);
    const sent: { url: string; key: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url).split("?")[0]!, key: new Headers(init?.headers).get("api-key") });
      return new Response(JSON.stringify({ meta: { errors: [{ code: 1, message: "stop" }] } }), { status: 400 });
    });
    try {
      const connector = yext.connector({ SANDBOX_YEXT_API_KEY: "k".repeat(32) });
      expect(connector.source).toBe("yext");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Yext answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://sbx-api.yextapis.com/v2/accounts/me/entities", key: "k".repeat(32) }]);
  });
});
