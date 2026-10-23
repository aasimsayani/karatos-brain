import { describe, expect, it, vi } from "vitest";
import metalsApi from "./metals_api.js";

describe("the Metals-API sandbox check", () => {
  it("builds the connector from the sandbox key with a week of history, and sends it to Metals-API", async () => {
    // Assembled at runtime so no key-shaped string sits in the repository.
    const key = ["test", "0".repeat(28)].join("");
    expect(metalsApi.credentials).toEqual(["SANDBOX_METALS_API_KEY"]);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      sent.push(String(url));
      return Response.json({ success: false, error: { code: 101, info: "stop here" } });
    });
    try {
      const connector = metalsApi.connector({ SANDBOX_METALS_API_KEY: key });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 101 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!);
    expect(url.origin + url.pathname).toBe("https://metals-api.com/api/timeseries");
    expect(url.searchParams.get("access_key")).toBe(key);
    const start = Date.parse(`${url.searchParams.get("start_date")}T00:00:00Z`);
    const end = Date.parse(`${url.searchParams.get("end_date")}T00:00:00Z`);
    expect((end - start) / 86_400_000).toBe(6);
  });
});
