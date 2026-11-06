import { describe, expect, it, vi } from "vitest";
import ga4 from "./google_analytics.js";

describe("the Google Analytics 4 sandbox check", () => {
  it("builds the GA4 connector for the test property, refreshing at Google with the test client's keys", async () => {
    expect(ga4.credentials).toEqual(["SANDBOX_GOOGLE_ANALYTICS_CLIENT_ID", "SANDBOX_GOOGLE_ANALYTICS_CLIENT_SECRET", "SANDBOX_GOOGLE_ANALYTICS_REFRESH_TOKEN", "SANDBOX_GOOGLE_ANALYTICS_PROPERTY_ID"]);
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3599, scope: "https://www.googleapis.com/auth/analytics.readonly" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 400, message: "stop", status: "INVALID_ARGUMENT" } }), { status: 400 });
    });
    try {
      const connector = ga4.connector({
        SANDBOX_GOOGLE_ANALYTICS_CLIENT_ID: "test-id",
        SANDBOX_GOOGLE_ANALYTICS_CLIENT_SECRET: "test-secret",
        SANDBOX_GOOGLE_ANALYTICS_REFRESH_TOKEN: "test-refresh",
        SANDBOX_GOOGLE_ANALYTICS_PROPERTY_ID: "123456789",
      });
      expect(connector.source).toBe("google_analytics");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Google Analytics answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://oauth2.googleapis.com/token", "POST https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport"]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("refresh_token"), form.get("grant_type")]).toEqual(["test-id", "test-secret", "test-refresh", "refresh_token"]);
    expect(sent[1]!.auth).toBe("Bearer test-access");
  });
});
