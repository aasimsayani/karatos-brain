import { describe, expect, it, vi } from "vitest";
import tiktokAds from "./tiktok_ads.js";

describe("the TikTok Ads sandbox check", () => {
  it("builds the TikTok Ads connector for the sandbox advertiser", async () => {
    expect(tiktokAds.credentials).toEqual(["SANDBOX_TIKTOK_ADS_ACCESS_TOKEN", "SANDBOX_TIKTOK_ADS_ADVERTISER_ID"]);
    const token = ["s", "0".repeat(39)].join("");
    const sent: { url: string; token: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url).split("?")[0]!, token: new Headers(init?.headers).get("access-token") });
      return new Response(JSON.stringify({ code: 40002, message: "stop", data: {} }), { status: 200 });
    });
    try {
      const connector = tiktokAds.connector({ SANDBOX_TIKTOK_ADS_ACCESS_TOKEN: token, SANDBOX_TIKTOK_ADS_ADVERTISER_ID: "7000000000000000001" });
      expect(connector.source).toBe("tiktok_ads");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("TikTok answered code 40002 for the report");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://sandbox-ads.tiktok.com/open_api/v1.3/report/integrated/get/", token }]);
  });
});
