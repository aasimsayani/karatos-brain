import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SandboxCheck } from "@karatos/core";
import { SANDBOX_CHECKS, credentialProblems } from "./sandbox-checks.js";

const WORKFLOW = readFileSync(new URL("../.github/workflows/sandbox-run.yml", import.meta.url), "utf8");

const check = (credentials: string[]): SandboxCheck => ({
  integration: "shopify",
  name: "Shopify",
  credentials,
  connector: () => {
    throw new Error("not used");
  },
});

describe("sandbox checks", () => {
  it("pass every registered check's credentials to the nightly job under sandbox-only names", () => {
    expect(credentialProblems(SANDBOX_CHECKS, WORKFLOW)).toEqual([]);
  });

  it("build the Shopify connector from sandbox credentials only", () => {
    const shopify = SANDBOX_CHECKS.find((c) => c.integration === "shopify")!;
    expect(shopify.credentials).toEqual(["SANDBOX_SHOPIFY_SHOP_DOMAIN", "SANDBOX_SHOPIFY_ADMIN_ACCESS_TOKEN"]);
    const connector = shopify.connector({ SANDBOX_SHOPIFY_SHOP_DOMAIN: "example-store.myshopify.com", SANDBOX_SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_test" });
    expect(connector.source).toBe("shopify");
  });

  it("build the Stripe connector from a test-mode restricted key only, and send it to Stripe", async () => {
    const stripe = SANDBOX_CHECKS.find((c) => c.integration === "stripe")!;
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

  it("catch a credential that isn't passed to the job or isn't a sandbox name", () => {
    const workflow = "          SANDBOX_SHOPIFY_ADMIN_TOKEN: ${{ secrets.SANDBOX_SHOPIFY_ADMIN_TOKEN }}\n";
    expect(credentialProblems([check(["SANDBOX_SHOPIFY_ADMIN_TOKEN"])], workflow)).toEqual([]);
    expect(credentialProblems([check(["SANDBOX_SHOPIFY_WEBHOOK_SECRET", "SHOPIFY_ADMIN_ACCESS_TOKEN"])], workflow)).toEqual([
      "shopify: SANDBOX_SHOPIFY_WEBHOOK_SECRET isn't passed to the job in sandbox-run.yml",
      "shopify: credential SHOPIFY_ADMIN_ACCESS_TOKEN must be named SANDBOX_SHOPIFY_<WHAT>",
      "shopify: SHOPIFY_ADMIN_ACCESS_TOKEN isn't passed to the job in sandbox-run.yml",
    ]);
  });
});
