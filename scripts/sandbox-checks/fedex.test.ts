import { describe, expect, it, vi } from "vitest";
import fedex, { FEDEX_SANDBOX_NUMBERS } from "./fedex.js";

describe("the FedEx sandbox check", () => {
  it("signs in at FedEx's sandbox only, with the test project's key and secret", async () => {
    expect(fedex.credentials).toEqual(["SANDBOX_FEDEX_CLIENT_ID", "SANDBOX_FEDEX_CLIENT_SECRET"]);
    // Shaped like a FedEx API key and secret, assembled so no scanner mistakes them for real ones.
    const id = ["test", "0".repeat(20)].join("");
    const secret = ["test", "1".repeat(28)].join("");
    const sent: { url: string; method: string; type: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", type: new Headers(init?.headers).get("content-type"), body: String(init?.body) });
      return new Response(JSON.stringify({ errors: [{ code: "NOT.AUTHORIZED.ERROR", message: "not valid" }] }), { status: 401 });
    });
    try {
      const connector = fedex.connector({ SANDBOX_FEDEX_CLIENT_ID: id, SANDBOX_FEDEX_CLIENT_SECRET: secret });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 401, code: "NOT.AUTHORIZED.ERROR" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect([sent[0]!.method, sent[0]!.url, sent[0]!.type]).toEqual(["POST", "https://apis-sandbox.fedex.com/oauth/token", "application/x-www-form-urlencoded"]);
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({ grant_type: "client_credentials", client_id: id, client_secret: secret });
    expect(FEDEX_SANDBOX_NUMBERS).toEqual(["123456789012", "111111111111"]);
  });
});
