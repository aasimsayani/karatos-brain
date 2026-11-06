import { describe, expect, it, vi } from "vitest";
import meta from "./meta_ads.js";

describe("the Meta Ads sandbox check", () => {
  it("builds the Meta Ads connector for the sandbox ad account, checking the token's permissions first", async () => {
    expect(meta.credentials).toEqual(["SANDBOX_META_ADS_ACCESS_TOKEN", "SANDBOX_META_ADS_ACCOUNT_ID"]);
    const token = `EAA${"s".repeat(40)}`;
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url).split("?")[0]!, auth: new Headers(init?.headers).get("authorization") });
      if (sent.length === 1) return new Response(JSON.stringify({ data: [{ permission: "ads_read", status: "granted" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "stop", code: 100 } }), { status: 400 });
    });
    try {
      const connector = meta.connector({ SANDBOX_META_ADS_ACCESS_TOKEN: token, SANDBOX_META_ADS_ACCOUNT_ID: "act_1234567890" });
      expect(connector.source).toBe("meta_ads");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Meta answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([
      { url: "https://graph.facebook.com/v26.0/me/permissions", auth: `Bearer ${token}` },
      { url: "https://graph.facebook.com/v26.0/act_1234567890/insights", auth: `Bearer ${token}` },
    ]);
  });
});
