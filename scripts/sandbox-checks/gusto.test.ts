import { describe, expect, it, vi } from "vitest";
import gusto from "./gusto.js";

describe("the Gusto sandbox check", () => {
  it("builds the Gusto connector against the demo environment, checking the token before reading payrolls", async () => {
    expect(gusto.credentials).toEqual(["SANDBOX_GUSTO_CLIENT_ID", "SANDBOX_GUSTO_CLIENT_SECRET", "SANDBOX_GUSTO_REDIRECT_URI", "SANDBOX_GUSTO_COMPANY_UUID", "SANDBOX_GUSTO_REFRESH_TOKEN"]);
    const company = "00000000-0000-4000-8000-00000000c0c0";
    const sent: { url: string; auth: string | null; version: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), auth: headers.get("authorization"), version: headers.get("x-gusto-api-version"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 7200, refresh_token: "test-refresh-2" }), { status: 200 });
      if (sent.length === 2) return new Response(JSON.stringify({ scope: "payrolls:read", resource: { type: "Company", uuid: company } }), { status: 200 });
      return new Response(JSON.stringify({ errors: [{ message: "stop" }] }), { status: 400 });
    });
    try {
      const connector = gusto.connector({
        SANDBOX_GUSTO_CLIENT_ID: "test-id",
        SANDBOX_GUSTO_CLIENT_SECRET: "test-secret",
        SANDBOX_GUSTO_REDIRECT_URI: "https://brain.example.test/oauth/gusto",
        SANDBOX_GUSTO_COMPANY_UUID: company,
        SANDBOX_GUSTO_REFRESH_TOKEN: "test-refresh",
      });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Gusto answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url.split("?")[0])).toEqual([
      "https://api.gusto-demo.com/oauth/token",
      "https://api.gusto-demo.com/v1/token_info",
      `https://api.gusto-demo.com/v1/companies/${company}/payrolls`,
    ]);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ client_id: "test-id", client_secret: "test-secret", refresh_token: "test-refresh", grant_type: "refresh_token" });
    expect(sent.slice(1).map((s) => [s.auth, s.version])).toEqual([
      ["Bearer test-access", "2026-06-15"],
      ["Bearer test-access", "2026-06-15"],
    ]);
  });
});
