import { describe, expect, it, vi } from "vitest";
import airtable from "./airtable.js";

describe("the Airtable sandbox check", () => {
  it("builds the Airtable connector with the test account's token", async () => {
    expect(airtable.credentials).toEqual(["SANDBOX_AIRTABLE_ACCESS_TOKEN"]);
    const token = ["pat", "x".repeat(14), ".", "x".repeat(64)].join("");
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ error: { type: "AUTHENTICATION_REQUIRED", message: "Authentication required" } }), { status: 401 });
    });
    try {
      const connector = airtable.connector({ SANDBOX_AIRTABLE_ACCESS_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down the token/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["GET https://api.airtable.com/v0/meta/whoami"]);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});
