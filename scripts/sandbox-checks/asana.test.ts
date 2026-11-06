import { describe, expect, it, vi } from "vitest";
import asana from "./asana.js";

describe("the Asana sandbox check", () => {
  it("builds the Asana connector with the test account's token", async () => {
    expect(asana.credentials).toEqual(["SANDBOX_ASANA_ACCESS_TOKEN"]);
    const token = ["2", "x".repeat(40)].join("/");
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 401 });
    });
    try {
      const connector = asana.connector({ SANDBOX_ASANA_ACCESS_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down the token/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["GET https://app.asana.com/api/1.0/users/me?opt_fields=workspaces.gid"]);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});
