import { describe, expect, it, vi } from "vitest";
import klaviyo from "./klaviyo.js";

describe("the Klaviyo sandbox check", () => {
  it("builds the Klaviyo connector with the test account's private key and the pinned revision", async () => {
    expect(klaviyo.credentials).toEqual(["SANDBOX_KLAVIYO_PRIVATE_API_KEY"]);
    const key = ["pk", "testkey".repeat(4)].join("_");
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ errors: [{ code: "not_authenticated", detail: "stop" }] }), { status: 401 });
    });
    try {
      const connector = klaviyo.connector({ SANDBOX_KLAVIYO_PRIVATE_API_KEY: key });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "not_authenticated" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual(["GET https://a.klaviyo.com/api/profiles/"]);
    expect(sent[0]!.headers.get("authorization")).toBe(`Klaviyo-API-Key ${key}`);
    expect(sent[0]!.headers.get("revision")).toBe("2026-10-15");
  });;
});
