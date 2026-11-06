import { describe, expect, it, vi } from "vitest";
import trello from "./trello.js";

describe("the Trello sandbox check", () => {
  it("builds the Trello connector with the test account's key and token", async () => {
    expect(trello.credentials).toEqual(["SANDBOX_TRELLO_API_KEY", "SANDBOX_TRELLO_TOKEN"]);
    const key = "a".repeat(32);
    const token = "x".repeat(64);
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify("invalid token"), { status: 401 });
    });
    try {
      const connector = trello.connector({ SANDBOX_TRELLO_API_KEY: key, SANDBOX_TRELLO_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down the key and token/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([`GET https://api.trello.com/1/tokens/${token}?fields=permissions`]);
    expect(sent[0]!.headers.get("authorization")).toBe(`OAuth oauth_consumer_key="${key}", oauth_token="${token}"`);
  });
});
