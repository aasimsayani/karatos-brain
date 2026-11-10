import { describe, expect, it, vi } from "vitest";
import lightspeed from "./lightspeed.js";

describe("the Lightspeed sandbox check", () => {
  it("refreshes at the trial store's own host with the test app's id, secret and refresh token", async () => {
    expect(lightspeed.credentials).toEqual(["SANDBOX_LIGHTSPEED_DOMAIN_PREFIX", "SANDBOX_LIGHTSPEED_CLIENT_ID", "SANDBOX_LIGHTSPEED_CLIENT_SECRET", "SANDBOX_LIGHTSPEED_REFRESH_TOKEN"]);
    // Shaped like a Lightspeed app's id and secret, assembled so no scanner mistakes them for real ones.
    const id = ["test", "0".repeat(20)].join("");
    const secret = ["test", "1".repeat(28)].join("");
    const sent: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", body: String(init?.body) });
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    });
    try {
      const connector = lightspeed.connector({ SANDBOX_LIGHTSPEED_DOMAIN_PREFIX: "trialstore", SANDBOX_LIGHTSPEED_CLIENT_ID: id, SANDBOX_LIGHTSPEED_CLIENT_SECRET: secret, SANDBOX_LIGHTSPEED_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("invalid_grant");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => [s.method, s.url])).toEqual([["POST", "https://trialstore.retail.lightspeed.app/api/1.0/token"]]);
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "test-refresh", client_id: id, client_secret: secret });
  });
});
