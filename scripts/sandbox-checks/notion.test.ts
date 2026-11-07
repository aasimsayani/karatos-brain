import { describe, expect, it, vi } from "vitest";
import notion from "./notion.js";

describe("the Notion sandbox check", () => {
  it("builds the Notion connector with the test account's token", async () => {
    expect(notion.credentials).toEqual(["SANDBOX_NOTION_ACCESS_TOKEN"]);
    const token = ["ntn", "x".repeat(46)].join("_");
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ object: "error", status: 401, code: "unauthorized", message: "API token is invalid." }), { status: 401 });
    });
    try {
      const connector = notion.connector({ SANDBOX_NOTION_ACCESS_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down the token/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://api.notion.com/v1/search"]);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(sent[0]!.headers.get("notion-version")).toBe("2026-03-11");
  });
});
