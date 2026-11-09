import { describe, expect, it, vi } from "vitest";
import dropbox from "./dropbox.js";

describe("the Dropbox sandbox check", () => {
  it("builds the Dropbox connector with the test app's settings, asking for read scopes only", async () => {
    expect(dropbox.credentials).toEqual(["SANDBOX_DROPBOX_APP_KEY", "SANDBOX_DROPBOX_APP_SECRET", "SANDBOX_DROPBOX_REFRESH_TOKEN"]);
    const settings = { SANDBOX_DROPBOX_APP_KEY: "k".repeat(15), SANDBOX_DROPBOX_APP_SECRET: "s".repeat(15), SANDBOX_DROPBOX_REFRESH_TOKEN: "r".repeat(64) };
    const sent: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token is invalid or revoked" }), { status: 400 });
    });
    try {
      const connector = dropbox.connector(settings);
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down DROPBOX_REFRESH_TOKEN/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://api.dropboxapi.com/oauth2/token"]);
    expect(new URLSearchParams(sent[0]!.body).get("scope")).toBe("account_info.read files.metadata.read");
  });
});
