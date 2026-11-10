import { describe, expect, it, vi } from "vitest";
import ups, { UPS_SANDBOX_NUMBERS } from "./ups.js";

describe("the UPS sandbox check", () => {
  it("signs in at UPS's test environment only, with the test app's id and secret", async () => {
    expect(ups.credentials).toEqual(["SANDBOX_UPS_CLIENT_ID", "SANDBOX_UPS_CLIENT_SECRET"]);
    // Shaped like a UPS client id and secret, assembled so no scanner mistakes them for real ones.
    const id = ["test", "0".repeat(20)].join("");
    const secret = ["test", "1".repeat(40)].join("");
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      return new Response(JSON.stringify({ response: { errors: [{ code: "10401", message: "ClientId is Invalid" }] } }), { status: 401 });
    });
    try {
      const connector = ups.connector({ SANDBOX_UPS_CLIENT_ID: id, SANDBOX_UPS_CLIENT_SECRET: secret });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 401, code: "10401" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect([sent[0]!.method, sent[0]!.url, sent[0]!.body]).toEqual(["POST", "https://wwwcie.ups.com/security/v1/oauth/token", "grant_type=client_credentials"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`);
    expect(UPS_SANDBOX_NUMBERS.every((n) => n.startsWith("1Z12345E"))).toBe(true);
  });
});
