import { describe, expect, it, vi } from "vitest";
import avalara from "./avalara.js";

describe("the Avalara sandbox check", () => {
  it("builds the AvaTax connector against the sandbox with the test account's key", async () => {
    expect(avalara.credentials).toEqual(["SANDBOX_AVALARA_ACCOUNT_ID", "SANDBOX_AVALARA_LICENSE_KEY"]);
    const licenseKey = "x".repeat(16);
    const sent: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ version: "26.10.0", authenticated: false }), { status: 200 });
    });
    try {
      const connector = avalara.connector({ SANDBOX_AVALARA_ACCOUNT_ID: "2000000001", SANDBOX_AVALARA_LICENSE_KEY: licenseKey });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow(/turned down the account ID and license key/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["GET https://sandbox-rest.avatax.com/api/v2/utilities/ping"]);
    expect(sent[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from(`2000000001:${licenseKey}`).toString("base64")}`);
  });
});
