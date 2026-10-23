import { describe, expect, it, vi } from "vitest";
import affirm from "./affirm.js";

describe("the Affirm sandbox check", () => {
  it("builds the Affirm connector against the sandbox host only, GETting with the sandbox key pair", async () => {
    expect(affirm.credentials).toEqual(["SANDBOX_AFFIRM_PUBLIC_API_KEY", "SANDBOX_AFFIRM_PRIVATE_API_KEY", "SANDBOX_AFFIRM_MERCHANT_ID"]);
    // Shaped like Affirm's key pair, assembled so no scanner mistakes them for real ones.
    const publicKey = ["TESTPUB", "0".repeat(9)].join("");
    const privateKey = ["TESTPRIV", "0".repeat(24)].join("");
    const sent: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ status_code: "401", code: "stop_here", message: "stop" }), { status: 401 });
    });
    try {
      const connector = affirm.connector({ SANDBOX_AFFIRM_PUBLIC_API_KEY: publicKey, SANDBOX_AFFIRM_PRIVATE_API_KEY: privateKey, SANDBOX_AFFIRM_MERCHANT_ID: "MERCHANT-TEST" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect([sent[0]!.method, url.origin + url.pathname]).toEqual(["GET", "https://sandbox.affirm.com/api/v1/transactions"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from(`${publicKey}:${privateKey}`).toString("base64")}`);
  });
});
