import { describe, expect, it, vi } from "vitest";
import onedrive from "./microsoft_onedrive.js";

const guid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;

describe("the OneDrive and SharePoint sandbox check", () => {
  it("builds the connector with the test app's settings, signing in as the app for Graph only", async () => {
    expect(onedrive.credentials).toEqual(["SANDBOX_MICROSOFT_ONEDRIVE_TENANT_ID", "SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_ID", "SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_SECRET", "SANDBOX_MICROSOFT_ONEDRIVE_DRIVE_ID"]);
    const settings = { SANDBOX_MICROSOFT_ONEDRIVE_TENANT_ID: guid("a"), SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_ID: guid("b"), SANDBOX_MICROSOFT_ONEDRIVE_CLIENT_SECRET: "s".repeat(40), SANDBOX_MICROSOFT_ONEDRIVE_DRIVE_ID: `b!${"d".repeat(64)}` };
    const sent: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error: "invalid_client", error_codes: [7000215] }), { status: 401 });
    });
    try {
      const connector = onedrive.connector(settings);
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down MICROSOFT_CLIENT_SECRET/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`POST https://login.microsoftonline.com/${guid("a")}/oauth2/v2.0/token`]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("grant_type"), form.get("scope")]).toEqual(["client_credentials", "https://graph.microsoft.com/.default"]);
  });
});
