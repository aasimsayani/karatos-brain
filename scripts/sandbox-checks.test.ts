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

  it("build the Shopify connector from sandbox credentials only, signing in to the sandbox store with them", async () => {
    const shopify = SANDBOX_CHECKS.find((c) => c.integration === "shopify")!;
    expect(shopify.credentials).toEqual(["SANDBOX_SHOPIFY_SHOP_DOMAIN", "SANDBOX_SHOPIFY_CLIENT_ID", "SANDBOX_SHOPIFY_CLIENT_SECRET"]);
    // The check builds its connector with the global fetch, so stub it to see what the connector sends.
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ error: "stop_here" }), { status: 400 });
    });
    try {
      const connector = shopify.connector({ SANDBOX_SHOPIFY_SHOP_DOMAIN: "example-store.myshopify.com", SANDBOX_SHOPIFY_CLIENT_ID: "test-id", SANDBOX_SHOPIFY_CLIENT_SECRET: "test-secret" });
      expect(connector.source).toBe("shopify");
      const batches = connector.incrementalSync({ cursor: null } as Parameters<typeof connector.incrementalSync>[0]);
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://example-store.myshopify.com/admin/oauth/access_token");
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret")]).toEqual(["test-id", "test-secret"]);
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

  it("build the QuickBooks connector against the sandbox API only, refreshing at Intuit with the sandbox app's keys", async () => {
    const quickbooks = SANDBOX_CHECKS.find((c) => c.integration === "quickbooks")!;
    expect(quickbooks.credentials).toEqual(["SANDBOX_QUICKBOOKS_CLIENT_ID", "SANDBOX_QUICKBOOKS_CLIENT_SECRET", "SANDBOX_QUICKBOOKS_REALM_ID", "SANDBOX_QUICKBOOKS_REFRESH_TOKEN"]);
    const sent: { url: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3600, refresh_token: "test-refresh-2" }), { status: 200 });
      return new Response(JSON.stringify({ Fault: { Error: [{ Message: "stop", code: "stop_here" }] } }), { status: 400 });
    });
    try {
      const connector = quickbooks.connector({ SANDBOX_QUICKBOOKS_CLIENT_ID: "test-id", SANDBOX_QUICKBOOKS_CLIENT_SECRET: "test-secret", SANDBOX_QUICKBOOKS_REALM_ID: "9341450000", SANDBOX_QUICKBOOKS_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "stop_here" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url.split("?")[0])).toEqual(["https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", "https://sandbox-quickbooks.api.intuit.com/v3/company/9341450000/query"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
    expect(new URLSearchParams(sent[0]!.body).get("refresh_token")).toBe("test-refresh");
    expect(sent[1]!.auth).toBe("Bearer test-access");
  });

  it("build the Clover connector against the sandbox host only, with the test merchant's API token", async () => {
    const clover = SANDBOX_CHECKS.find((c) => c.integration === "clover")!;
    expect(clover.credentials).toEqual(["SANDBOX_CLOVER_MERCHANT_ID", "SANDBOX_CLOVER_API_TOKEN", "SANDBOX_CLOVER_CUSTOMER_REF_KEY"]);
    const sent: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ message: "stop" }), { status: 400 });
    });
    try {
      const connector = clover.connector({ SANDBOX_CLOVER_MERCHANT_ID: "MTEST0000000A", SANDBOX_CLOVER_API_TOKEN: "test-token", SANDBOX_CLOVER_CUSTOMER_REF_KEY: "k".repeat(64) });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Clover answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent).toEqual([{ url: "https://apisandbox.dev.clover.com/v3/merchants/MTEST0000000A", method: "GET", auth: "Bearer test-token" }]);
  });

  it("build the Xero connector with the Demo Company's tenant, refreshing at Xero's identity service", async () => {
    const xero = SANDBOX_CHECKS.find((c) => c.integration === "xero")!;
    expect(xero.credentials).toEqual(["SANDBOX_XERO_CLIENT_ID", "SANDBOX_XERO_CLIENT_SECRET", "SANDBOX_XERO_TENANT_ID", "SANDBOX_XERO_REFRESH_TOKEN"]);
    const tenant = "00000000-0000-4000-8000-00000000a0a0";
    const sent: { url: string; auth: string | null; tenant: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ url: String(url), auth: headers.get("authorization"), tenant: headers.get("xero-tenant-id"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 1800, refresh_token: "test-refresh-2" }), { status: 200 });
      return new Response(JSON.stringify({ Message: "stop" }), { status: 400 });
    });
    try {
      const connector = xero.connector({ SANDBOX_XERO_CLIENT_ID: "test-id", SANDBOX_XERO_CLIENT_SECRET: "test-secret", SANDBOX_XERO_TENANT_ID: tenant, SANDBOX_XERO_REFRESH_TOKEN: "test-refresh" });
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Xero answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => s.url)).toEqual(["https://identity.xero.com/connect/token", "https://api.xero.com/api.xro/2.0/Accounts"]);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from("test-id:test-secret").toString("base64")}`);
    expect(new URLSearchParams(sent[0]!.body).get("refresh_token")).toBe("test-refresh");
    expect([sent[1]!.auth, sent[1]!.tenant]).toEqual(["Bearer test-access", tenant]);
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
