import { describe, expect, it, vi } from "vitest";
import aurora from "./aurora_payments.js";

describe("the Aurora Payments sandbox check", () => {
  it("builds the Aurora Payments connector against Flute's sandbox, signing in first", async () => {
    expect(aurora.credentials).toEqual(["SANDBOX_AURORA_PAYMENTS_CLIENT_ID", "SANDBOX_AURORA_PAYMENTS_CLIENT_SECRET"]);
    // Shaped like a client ID and secret, assembled so no scanner mistakes them for real ones.
    const id = ["test", "0".repeat(12)].join("-");
    const secret = ["s", "0".repeat(31)].join("");
    const sent: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "" });
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    });
    try {
      const connector = aurora.connector({ SANDBOX_AURORA_PAYMENTS_CLIENT_ID: id, SANDBOX_AURORA_PAYMENTS_CLIENT_SECRET: secret });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Flute turned down AURORA_CLIENT_ID and AURORA_CLIENT_SECRET (HTTP 401); check the key is for sandbox");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["POST https://sandbox.oauth.api.flute.com/oauth2/token"]);
  });
});
