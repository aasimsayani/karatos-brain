import { describe, expect, it, vi } from "vitest";
import hubspot from "./hubspot.js";

describe("the HubSpot sandbox check", () => {
  it("builds the HubSpot connector from the test account's private app token, checking its scopes first", async () => {
    expect(hubspot.credentials).toEqual(["SANDBOX_HUBSPOT_ACCESS_TOKEN"]);
    // Token-shaped, assembled so no scanner mistakes the source for a leaked token.
    const token = ["pat", "na1", ["00000000", "0000", "4000", "8000", "000000000000"].join("-")].join("-");
    const sent: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ status: "error", message: "stop", category: "STOP" }), { status: 400 });
    });
    try {
      const connector = hubspot.connector({ SANDBOX_HUBSPOT_ACCESS_TOKEN: token });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("HubSpot answered HTTP 400 to a token_info read (STOP: stop)");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info"]);
    expect([sent[0]!.auth, JSON.parse(sent[0]!.body)]).toEqual([`Bearer ${token}`, { tokenKey: token }]);
  });;
});
