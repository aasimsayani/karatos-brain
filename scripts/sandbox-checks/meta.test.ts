import { describe, expect, it, vi } from "vitest";
import meta from "./meta.js";

describe("the Meta sandbox check", () => {
  it("builds the connector for the test Page's Messenger conversations", async () => {
    expect(meta.credentials).toEqual(["SANDBOX_META_PAGE_ID", "SANDBOX_META_PAGE_ACCESS_TOKEN"]);
    const token = `EAA${"s".repeat(40)}`;
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ error: { message: "stop", code: 2 } }), { status: 400 });
    });
    try {
      const connector = meta.connector({ SANDBOX_META_PAGE_ID: "1000000001", SANDBOX_META_PAGE_ACCESS_TOKEN: token });
      expect(connector.source).toBe("meta");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Meta answered HTTP 400 for the messenger conversations (code 2)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://graph.facebook.com/v26.0/1000000001/conversations?platform=messenger&fields=id%2Cupdated_time", auth: `Bearer ${token}` }]);
  });
});
