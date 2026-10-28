import { describe, expect, it, vi } from "vitest";
import gia, { GIA_SANDBOX_REPORTS } from "./gia.js";

describe("the GIA sandbox check", () => {
  it("looks up GIA's published sandbox reports only, POSTing to the sandbox address with the sandbox key", async () => {
    expect(gia.credentials).toEqual(["SANDBOX_GIA_API_URL", "SANDBOX_GIA_API_KEY"]);
    // Shaped like a GIA API key, assembled so no scanner mistakes it for a real one.
    const key = ["test", "gia", "0".repeat(24)].join("-");
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      return new Response(JSON.stringify({ message: "stop" }), { status: 403 });
    });
    try {
      const connector = gia.connector({ SANDBOX_GIA_API_URL: "https://api.reportresults.gia.edu", SANDBOX_GIA_API_KEY: key });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect([sent[0]!.method, sent[0]!.url, sent[0]!.auth]).toEqual(["POST", "https://api.reportresults.gia.edu/", key]);
    expect(JSON.parse(sent[0]!.body).variables).toEqual({ reportNumber: GIA_SANDBOX_REPORTS[0] });
    expect(() => gia.connector({ SANDBOX_GIA_API_URL: "https://sandbox.example.test", SANDBOX_GIA_API_KEY: key })).toThrow(/gia\.edu host/);
  });
});
