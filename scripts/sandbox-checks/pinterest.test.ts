import { describe, expect, it, vi } from "vitest";
import pinterest from "./pinterest.js";

describe("the Pinterest sandbox check", () => {
  it("builds the Pinterest connector for the test account, checking the token's scopes first", async () => {
    expect(pinterest.credentials).toEqual(["SANDBOX_PINTEREST_CLIENT_ID", "SANDBOX_PINTEREST_CLIENT_SECRET", "SANDBOX_PINTEREST_REFRESH_TOKEN"]);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      sent.push(String(url).split("?")[0]!);
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600, scope: "boards:read,pins:read,user_accounts:read" }), { status: 200 });
      return new Response(JSON.stringify({ code: 1, message: "stop" }), { status: 400 });
    });
    try {
      const connector = pinterest.connector({ SANDBOX_PINTEREST_CLIENT_ID: "1234567", SANDBOX_PINTEREST_CLIENT_SECRET: "s".repeat(40), SANDBOX_PINTEREST_REFRESH_TOKEN: `pinr.${"r".repeat(40)}` });
      expect(connector.source).toBe("pinterest");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Pinterest answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual(["https://api.pinterest.com/v5/oauth/token", "https://api.pinterest.com/v5/pins"]);
  });
});
