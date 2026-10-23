import { describe, expect, it, vi } from "vitest";
import quickbooks from "./quickbooks.js";

describe("the QuickBooks Online sandbox check", () => {
  it("builds the QuickBooks connector against the sandbox API only, refreshing at Intuit with the sandbox app's keys", async () => {
    expect(quickbooks.credentials).toEqual(["SANDBOX_QUICKBOOKS_CLIENT_ID", "SANDBOX_QUICKBOOKS_CLIENT_SECRET", "SANDBOX_QUICKBOOKS_REALM_ID", "SANDBOX_QUICKBOOKS_REFRESH_TOKEN"]);
    const sent: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3600, refresh_token: "test-refresh-2" }), { status: 200 });
      return new Response(JSON.stringify({ Fault: { Error: [{ Message: "stop", code: "stop_here" }] } }), { status: 400 });
    });
    try {
      const connector = quickbooks.connector({ SANDBOX_QUICKBOOKS_CLIENT_ID: "test-id", SANDBOX_QUICKBOOKS_CLIENT_SECRET: "test-secret", SANDBOX_QUICKBOOKS_REALM_ID: "9341450000", SANDBOX_QUICKBOOKS_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url.split("?")[0])).toEqual(["https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", "https://sandbox-quickbooks.api.intuit.com/v3/company/9341450000/query"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
    expect(new URLSearchParams(sent[0]!.body).get("refresh_token")).toBe("test-refresh");
    expect(sent[1]!.auth).toBe("Bearer test-access");
  });
});
