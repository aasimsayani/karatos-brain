import { describe, expect, it, vi } from "vitest";
import ads from "./google_ads.js";

describe("the Google Ads sandbox check", () => {
  it("builds the Google Ads connector for the test account under its test manager, refreshing at Google with the test client's keys", async () => {
    expect(ads.credentials).toEqual([
      "SANDBOX_GOOGLE_ADS_CLIENT_ID",
      "SANDBOX_GOOGLE_ADS_CLIENT_SECRET",
      "SANDBOX_GOOGLE_ADS_REFRESH_TOKEN",
      "SANDBOX_GOOGLE_ADS_DEVELOPER_TOKEN",
      "SANDBOX_GOOGLE_ADS_CUSTOMER_ID",
      "SANDBOX_GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    ]);
    const sent: { url: string; method: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3599, scope: "https://www.googleapis.com/auth/adwords" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 400, message: "stop", status: "INVALID_ARGUMENT" } }), { status: 400 });
    });
    try {
      const connector = ads.connector({
        SANDBOX_GOOGLE_ADS_CLIENT_ID: "test-id",
        SANDBOX_GOOGLE_ADS_CLIENT_SECRET: "test-secret",
        SANDBOX_GOOGLE_ADS_REFRESH_TOKEN: "test-refresh",
        SANDBOX_GOOGLE_ADS_DEVELOPER_TOKEN: "test-developer",
        SANDBOX_GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
        SANDBOX_GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
      });
      expect(connector.source).toBe("google_ads");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Google Ads answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://oauth2.googleapis.com/token", "POST https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search"]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("refresh_token"), form.get("grant_type")]).toEqual(["test-id", "test-secret", "test-refresh", "refresh_token"]);
    expect([sent[1]!.headers.get("authorization"), sent[1]!.headers.get("developer-token"), sent[1]!.headers.get("login-customer-id")]).toEqual(["Bearer test-access", "test-developer", "1112223333"]);
  });
});
