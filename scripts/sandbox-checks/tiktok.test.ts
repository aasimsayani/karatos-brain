import { describe, expect, it, vi } from "vitest";
import tiktok from "./tiktok.js";

describe("the TikTok sandbox check", () => {
  it("builds the TikTok connector for the test account, checking the token's scopes first", async () => {
    expect(tiktok.credentials).toEqual(["SANDBOX_TIKTOK_CLIENT_KEY", "SANDBOX_TIKTOK_CLIENT_SECRET", "SANDBOX_TIKTOK_REFRESH_TOKEN"]);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      sent.push(String(url).split("?")[0]!);
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "AT", expires_in: 86400, scope: "user.info.basic,user.info.stats,video.list" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "invalid_params", message: "stop" } }), { status: 400 });
    });
    try {
      const connector = tiktok.connector({ SANDBOX_TIKTOK_CLIENT_KEY: `aw${"k".repeat(14)}`, SANDBOX_TIKTOK_CLIENT_SECRET: "s".repeat(32), SANDBOX_TIKTOK_REFRESH_TOKEN: `rft.${"r".repeat(40)}` });
      expect(connector.source).toBe("tiktok");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("TikTok answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual(["https://open.tiktokapis.com/v2/oauth/token/", "https://open.tiktokapis.com/v2/user/info/"]);
  });
});
