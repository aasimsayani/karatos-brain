import { describe, expect, it, vi } from "vitest";
import calendly from "./calendly.js";

describe("the Calendly sandbox check", () => {
  it("builds the Calendly connector with the test account's token", async () => {
    expect(calendly.credentials).toEqual(["SANDBOX_CALENDLY_ACCESS_TOKEN"]);
    const token = ["calendly", "x".repeat(40)].join(".");
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ title: "Unauthenticated", message: "stop" }), { status: 401 });
    });
    try {
      const connector = calendly.connector({ SANDBOX_CALENDLY_ACCESS_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down the token/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["GET https://api.calendly.com/users/me"]);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});
