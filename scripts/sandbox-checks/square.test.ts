import { describe, expect, it, vi } from "vitest";
import square from "./square.js";

describe("the Square sandbox check", () => {
  it("builds the Square connector against the sandbox host, refreshing with the read scopes only", async () => {
    expect(square.credentials).toEqual(["SANDBOX_SQUARE_APPLICATION_ID", "SANDBOX_SQUARE_APPLICATION_SECRET", "SANDBOX_SQUARE_REFRESH_TOKEN"]);
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", detail: "stop" }] }), { status: 401 });
    });
    try {
      const connector = square.connector({ SANDBOX_SQUARE_APPLICATION_ID: "test-app", SANDBOX_SQUARE_APPLICATION_SECRET: "test-secret", SANDBOX_SQUARE_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://connect.squareupsandbox.com/oauth2/token"]);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ client_id: "test-app", client_secret: "test-secret", refresh_token: "test-refresh", scopes: ["MERCHANT_PROFILE_READ", "ITEMS_READ", "INVENTORY_READ", "CUSTOMERS_READ", "ORDERS_READ", "PAYMENTS_READ"] });
  });;
});
