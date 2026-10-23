import { describe, expect, it, vi } from "vitest";
import google from "./google_workspace.js";

describe("the Google Workspace and Drive sandbox check", () => {
  it("builds the Google Workspace connector for the test account's own folder, refreshing at Google with the test client's keys", async () => {
    expect(google.credentials).toEqual([
      "SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID",
      "SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET",
      "SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN",
      "SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID",
      "SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE",
    ]);
    const scope = ["drive.metadata.readonly", "spreadsheets.readonly", "calendar.events.readonly"].map((s) => `https://www.googleapis.com/auth/${s}`).join(" ");
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3599, scope }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 400, message: "stop" } }), { status: 400 });
    });
    try {
      const connector = google.connector({
        SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID: "test-id",
        SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET: "test-secret",
        SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN: "test-refresh",
        SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID: "1TestFolder_abcdefghij",
        SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE: "1TestSpreadsheet_abcdefghij/Stock!A1:C10",
      });
      expect(connector.source).toBe("google_workspace");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Google answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual(["POST https://oauth2.googleapis.com/token", "GET https://www.googleapis.com/drive/v3/changes/startPageToken"]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("refresh_token"), form.get("grant_type")]).toEqual(["test-id", "test-secret", "test-refresh", "refresh_token"]);
    expect(sent[1]!.auth).toBe("Bearer test-access");
  });;
});
