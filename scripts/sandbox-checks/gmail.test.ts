import { describe, expect, it, vi } from "vitest";
import gmail from "./gmail.js";

describe("the Gmail sandbox check", () => {
  it("builds the Gmail connector for the test account's own mailbox, refreshing at Google with the test client's keys", async () => {
    expect(gmail.credentials).toEqual(["SANDBOX_GMAIL_CLIENT_ID", "SANDBOX_GMAIL_CLIENT_SECRET", "SANDBOX_GMAIL_REFRESH_TOKEN"]);
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.metadata" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 400, message: "stop" } }), { status: 400 });
    });
    try {
      const connector = gmail.connector({ SANDBOX_GMAIL_CLIENT_ID: "test-id", SANDBOX_GMAIL_CLIENT_SECRET: "test-secret", SANDBOX_GMAIL_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Gmail answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://oauth2.googleapis.com/token", "GET https://gmail.googleapis.com/gmail/v1/users/me/labels"]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("refresh_token"), form.get("grant_type")]).toEqual(["test-id", "test-secret", "test-refresh", "refresh_token"]);
    expect(sent[1]!.auth).toBe("Bearer test-access");
  });;
});
