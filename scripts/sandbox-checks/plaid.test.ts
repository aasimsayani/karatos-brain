import { describe, expect, it, vi } from "vitest";
import plaid from "./plaid.js";

describe("the Plaid sandbox check", () => {
  it("builds the Plaid connector against the sandbox host only, with the sandbox keys in headers and the token in the body", async () => {
    expect(plaid.credentials).toEqual(["SANDBOX_PLAID_CLIENT_ID", "SANDBOX_PLAID_SECRET", "SANDBOX_PLAID_ACCESS_TOKEN"]);
    // Token-shaped test values, assembled so no scanner mistakes the source for a leaked token.
    const token = ["access", "sandbox", "0".repeat(8)].join("-");
    const production = ["access", "production", "0".repeat(8)].join("-");
    expect(() => plaid.connector({ SANDBOX_PLAID_CLIENT_ID: "test-id", SANDBOX_PLAID_SECRET: "test-secret", SANDBOX_PLAID_ACCESS_TOKEN: production })).toThrow("not sandbox");
    const sent: { url: string; id: string | null; secret: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), id: headers.get("plaid-client-id"), secret: headers.get("plaid-secret"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error_type: "INVALID_INPUT", error_code: "stop_here", error_message: "stop" }), { status: 400 });
    });
    try {
      const connector = plaid.connector({ SANDBOX_PLAID_CLIENT_ID: "test-id", SANDBOX_PLAID_SECRET: "test-secret", SANDBOX_PLAID_ACCESS_TOKEN: token });
      expect(connector.source).toBe("plaid");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://sandbox.plaid.com/accounts/get"]);
    expect([sent[0]!.id, sent[0]!.secret]).toEqual(["test-id", "test-secret"]);
    expect(JSON.parse(sent[0]!.body)).toEqual({ access_token: token });
  });
});
