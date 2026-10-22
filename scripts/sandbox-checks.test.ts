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

  it("build the HubSpot connector from the test account's private app token, checking its scopes first", async () => {
    const hubspot = SANDBOX_CHECKS.find((c) => c.integration === "hubspot")!;
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
  });

  it("build the Plaid connector against the sandbox host only, with the sandbox keys in headers and the token in the body", async () => {
    const plaid = SANDBOX_CHECKS.find((c) => c.integration === "plaid")!;
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
