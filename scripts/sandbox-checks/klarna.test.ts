import { describe, expect, it, vi } from "vitest";
import klarna from "./klarna.js";

describe("the Klarna sandbox check", () => {
  it("builds the Klarna connector against the North American playground, reading payouts only", async () => {
    expect(klarna.credentials).toEqual(["SANDBOX_KLARNA_API_KEY"]);
    // Shaped like a Klarna test key, assembled so no scanner mistakes it for a real one.
    const key = ["klarna", "test", "api", "0".repeat(24)].join("_");
    const sent: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "" });
      return new Response(JSON.stringify({ error_code: "UNAUTHORIZED" }), { status: 401 });
    });
    try {
      const connector = klarna.connector({ SANDBOX_KLARNA_API_KEY: key });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Klarna turned down the credential for payouts (HTTP 401)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${new URL(s.url).origin}${new URL(s.url).pathname}`)).toEqual(["GET https://api-na.playground.klarna.com/settlements/v1/payouts"]);
  });

  it("won't send a live key to the playground", () => {
    const live = ["klarna", "live", "api", "0".repeat(24)].join("_");
    expect(() => klarna.connector({ SANDBOX_KLARNA_API_KEY: live })).toThrow("KLARNA_API_KEY is a live key, so it can't be used with the playground API");
  });
});
