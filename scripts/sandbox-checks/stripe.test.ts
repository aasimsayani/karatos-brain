import { describe, expect, it, vi } from "vitest";
import stripe from "./stripe.js";

describe("the Stripe sandbox check", () => {
  it("builds the Stripe connector from a test-mode restricted key only, and send it to Stripe", async () => {
    // Key-shaped test values, assembled so no scanner mistakes the source for a leaked key.
    const restricted = ["rk", "test", "0".repeat(24)].join("_");
    const full = ["sk", "test", "0".repeat(24)].join("_");
    expect(stripe.credentials).toEqual(["SANDBOX_STRIPE_SECRET_KEY"]);
    expect(() => stripe.connector({ SANDBOX_STRIPE_SECRET_KEY: full })).toThrow("restricted key");
    const sent: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ error: { code: "stop_here", message: "stop" } }), { status: 400 });
    });
    try {
      const connector = stripe.connector({ SANDBOX_STRIPE_SECRET_KEY: restricted });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.stripe.com/v1/charges");
    expect(sent[0]!.auth).toBe(`Bearer ${restricted}`);
  });
});
