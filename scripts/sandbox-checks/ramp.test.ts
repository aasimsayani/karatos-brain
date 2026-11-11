import { describe, expect, it, vi } from "vitest";
import ramp from "./ramp.js";

describe("the Ramp sandbox check", () => {
  it("builds the Ramp connector against the sandbox, asking for transactions:read only", async () => {
    expect(ramp.credentials).toEqual(["SANDBOX_RAMP_CLIENT_ID", "SANDBOX_RAMP_CLIENT_SECRET"]);
    // Shaped like Ramp credentials, assembled so no scanner mistakes them for real ones.
    const id = ["ramp", "id", "0".repeat(16)].join("_");
    const secret = ["ramp", "sec", "0".repeat(24)].join("_");
    const sent: { url: string; method: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", body: String(init?.body) });
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    });
    try {
      const connector = ramp.connector({ SANDBOX_RAMP_CLIENT_ID: id, SANDBOX_RAMP_CLIENT_SECRET: secret });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Ramp turned down RAMP_CLIENT_ID and RAMP_CLIENT_SECRET (HTTP 401)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://demo-api.ramp.com/developer/v1/token"]);
    expect(sent[0]!.body).toBe("grant_type=client_credentials&scope=transactions%3Aread");
  });
});
