import { describe, expect, it, vi } from "vitest";
import xero from "./xero.js";

describe("the Xero sandbox check", () => {
  it("builds the Xero connector with the Demo Company's tenant, refreshing at Xero's identity service", async () => {
    expect(xero.credentials).toEqual(["SANDBOX_XERO_CLIENT_ID", "SANDBOX_XERO_CLIENT_SECRET", "SANDBOX_XERO_TENANT_ID", "SANDBOX_XERO_REFRESH_TOKEN"]);
    const tenant = "00000000-0000-4000-8000-00000000a0a0";
    const sent: { url: string; auth: string | null; tenant: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), auth: headers.get("authorization"), tenant: headers.get("xero-tenant-id"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 1800, refresh_token: "test-refresh-2" }), { status: 200 });
      return new Response(JSON.stringify({ Message: "stop" }), { status: 400 });
    });
    try {
      const connector = xero.connector({ SANDBOX_XERO_CLIENT_ID: "test-id", SANDBOX_XERO_CLIENT_SECRET: "test-secret", SANDBOX_XERO_TENANT_ID: tenant, SANDBOX_XERO_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Xero answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://identity.xero.com/connect/token", "https://api.xero.com/api.xro/2.0/Accounts"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
    expect(new URLSearchParams(sent[0]!.body).get("refresh_token")).toBe("test-refresh");
    expect([sent[1]!.auth, sent[1]!.tenant]).toEqual(["Bearer test-access", tenant]);
  });
});
