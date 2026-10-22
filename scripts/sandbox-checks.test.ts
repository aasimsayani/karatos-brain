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

  it("build the Google Workspace connector for the test account's own folder, refreshing at Google with the test client's keys", async () => {
    const google = SANDBOX_CHECKS.find((c) => c.integration === "google_workspace")!;
    expect(google.credentials).toEqual([
      "SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID",
      "SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET",
      "SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN",
      "SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID",
      "SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE",
    ]);
    const scope = ["drive.metadata.readonly", "spreadsheets.readonly", "calendar.events.readonly"].map((s) => `https://www.googleapis.com/auth/${s}`).join(" ");
    const sent: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (sent.length === 1) return new Response(JSON.stringify({ access_token: "test-access", expires_in: 3599, scope }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 400, message: "stop" } }), { status: 400 });
    });
    try {
      const connector = google.connector({
        SANDBOX_GOOGLE_WORKSPACE_CLIENT_ID: "test-id",
        SANDBOX_GOOGLE_WORKSPACE_CLIENT_SECRET: "test-secret",
        SANDBOX_GOOGLE_WORKSPACE_REFRESH_TOKEN: "test-refresh",
        SANDBOX_GOOGLE_WORKSPACE_FOLDER_ID: "1TestFolder_abcdefghij",
        SANDBOX_GOOGLE_WORKSPACE_SHEETS_RANGE: "1TestSpreadsheet_abcdefghij/Stock!A1:C10",
      });
      expect(connector.source).toBe("google_workspace");
      const batches = connector.historicalImport({ organizationId: "demo-store", cursor: null });
      await expect(batches[Symbol.asyncIterator]().next()).rejects.toThrow("Google answered HTTP 400: stop");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(sent.map((s) => `${s.method} ${s.url.split("?")[0]}`)).toEqual(["POST https://oauth2.googleapis.com/token", "GET https://www.googleapis.com/drive/v3/changes/startPageToken"]);
    const form = new URLSearchParams(sent[0]!.body);
    expect([form.get("client_id"), form.get("client_secret"), form.get("refresh_token"), form.get("grant_type")]).toEqual(["test-id", "test-secret", "test-refresh", "refresh_token"]);
    expect(sent[1]!.auth).toBe("Bearer test-access");
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
