import { describe, expect, it, vi } from "vitest";
import monday from "./monday.js";

describe("the Monday.com sandbox check", () => {
  it("builds the monday.com connector with the developer account's token in the Authorization header, pinned to an API version", async () => {
    expect(monday.credentials).toEqual(["SANDBOX_MONDAY_API_TOKEN"]);
    const token = ["monday", "sandbox", "0".repeat(24)].join("-");
    const sent: { url: string; auth: string | null; version: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), auth: headers.get("authorization"), version: headers.get("api-version"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ errors: [{ message: "stop", extensions: { code: "stop_here" } }] }), { status: 200 });
    });
    try {
      const connector = monday.connector({ SANDBOX_MONDAY_API_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect([sent[0]!.url, sent[0]!.auth, sent[0]!.version]).toEqual(["https://api.monday.com/v2", token, "2026-07"]);
    expect(JSON.parse(sent[0]!.body).query).toMatch(/^query Boards\(/);
  });
});
