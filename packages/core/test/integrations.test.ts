import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS, integrationStatuses, integrationsFor, mergeCatalog, parseManifest, selfServeIntegrations, type CatalogRow } from "../src/index.js";

const catalogDoc = readFileSync(new URL("../../../docs/integrations.md", import.meta.url), "utf8");
const manifest = parseManifest(
  JSON.parse(readFileSync(new URL("../../../secrets/manifest.json", import.meta.url), "utf8")),
);

describe("integration catalog", () => {
  it("has unique ids", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents every setting each integration needs in the secrets manifest", () => {
    const documented = new Set(manifest.entries.map((e) => e.name));
    const missing = INTEGRATIONS.flatMap((i) => [...i.settings, ...(i.signIn ?? []).flat()].filter((s) => !documented.has(s)).map((s) => `${i.id}:${s}`));
    expect(missing).toEqual([]);
  });

  it("marks each integration's own secrets as needed only once it is enabled", () => {
    const byName = new Map(manifest.entries.map((e) => [e.name, e]));
    for (const integration of INTEGRATIONS) {
      for (const setting of [...integration.settings, ...(integration.signIn ?? []).flat()]) {
        const entry = byName.get(setting)!;
        const scoped = entry.requiredFor.includes(`integration:${integration.id}`) || entry.requiredFor.includes("instance");
        expect(scoped, `${setting} should be required for integration:${integration.id}`).toBe(true);
      }
    }
  });

  it("says what every built connector gives the business, and promises nothing for the rest", () => {
    for (const integration of INTEGRATIONS) {
      if (integration.status === "built") {
        expect(integration.capabilities?.length ?? 0, integration.id).toBeGreaterThanOrEqual(2);
        for (const line of integration.capabilities!) expect(line, integration.id).toMatch(/^[A-Z].{10,140}[^.]$/);
      } else {
        expect(integration.capabilities, integration.id).toBeUndefined();
      }
    }
  });

  it("names at least one kind of business for every integration", () => {
    const missing = INTEGRATIONS.filter((i) => i.segments.length === 0).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it("filters the catalog by kind of business", () => {
    const wholesale = integrationsFor("wholesale").map((i) => i.id);
    expect(wholesale).toContain("rapnet");
    expect(wholesale).toContain("edi_x12");
    expect(wholesale).not.toContain("the_edge");
    expect(integrationsFor("retail").map((i) => i.id)).toContain("the_edge");
  });

  it("lists every integration in docs/integrations.md", () => {
    const missing = INTEGRATIONS.filter((i) => !catalogDoc.includes(`| ${i.name} |`)).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it("counts only integrations we can test without asking a vendor as self-serve", () => {
    const selfServe = selfServeIntegrations();
    const ids = selfServe.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(["shopify", "quickbooks", "edi_x12", "bank_statements"]));
    expect(ids).not.toContain("the_edge");
    expect(ids).not.toContain("rapnet");
    for (const integration of selfServe) {
      expect(integration.access).not.toBe("partner");
      expect(["sandbox", "fixtures"]).toContain(integration.testWith);
    }
  });
});

describe("mergeCatalog", () => {
  const row = (id: string, over: Partial<CatalogRow> = {}): CatalogRow => ({
    id, name: id, domain: "crm", segments: ["retail"], access: "public_api", testWith: "sandbox", departments: ["sales"], historicalImportYears: 5, webhooks: true, settings: ["OLD"], changelog: null, ...over,
  });

  it("lays a built connector's own catalog fields over its row, and leaves the rest planned or deferred", () => {
    const merged = mergeCatalog([row("alpha", { note: "Old note" }), row("beta"), row("gamma", { status: "deferred" })], {
      alpha: { status: "built", note: "New note", capabilities: ["Does a useful thing"], settings: ["NEW"] },
    });
    expect(merged.map((i) => [i.id, i.status, i.note ?? null, i.settings])).toEqual([
      ["alpha", "built", "New note", ["NEW"]],
      ["beta", "planned", null, ["OLD"]],
      ["gamma", "deferred", null, ["OLD"]],
    ]);
    expect(merged[0]!.capabilities).toEqual(["Does a useful thing"]);
  });

  it("rejects a connector catalog entry with no row, and ignores inherited keys", () => {
    expect(() => mergeCatalog([row("alpha")], { zeta: { status: "built", capabilities: ["x"] } })).toThrow("catalog entries with no catalog row: zeta");
    expect(mergeCatalog([row("toString")], {})[0]!.status).toBe("planned");
  });
});

describe("integrationStatuses", () => {
  it("says which integrations this instance has every setting for, by name only", () => {
    const statuses = integrationStatuses({ STRIPE_SECRET_KEY: "stripe-test-value", STRIPE_WEBHOOK_SECRET: "  ", CHASE_IMPORT_MODE: "manual_csv", CHASE_MANUAL_IMPORT_DIR: "/imports" });
    expect(statuses).toHaveLength(INTEGRATIONS.length);
    expect(statuses.find((s) => s.id === "stripe")).toMatchObject({ configured: false, missingSettings: ["STRIPE_WEBHOOK_SECRET"] });
    expect(statuses.find((s) => s.id === "chase")).toMatchObject({ configured: true, missingSettings: [], access: "file", catalogStatus: "built" });
    // An integration with no settings of its own isn't configured just because nothing is missing.
    expect(statuses.find((s) => s.id === "punchmark")).toMatchObject({ configured: false, missingSettings: [] });
    expect(statuses.find((s) => s.id === "piro")).toMatchObject({ configured: false, missingSettings: ["PIRO_IMPORT_DIR"], access: "file", catalogStatus: "built" });
    expect(statuses.find((s) => s.id === "edi_x12")).toMatchObject({ configured: false, missingSettings: ["EDI_IMPORT_DIR"], catalogStatus: "built" });
    expect(statuses.find((s) => s.id === "bank_statements")).toMatchObject({ configured: false, missingSettings: ["BANK_STATEMENTS_IMPORT_DIR"] });
    expect(JSON.stringify(statuses)).not.toContain("stripe-test-value");
  });

  it("counts any one complete way to sign in, and asks for the first when none is", () => {
    const shopify = (env: Record<string, string>) => integrationStatuses(env).find((s) => s.id === "shopify")!;
    const domain = { SHOPIFY_SHOP_DOMAIN: "example-store.myshopify.com" };
    expect(shopify({})).toMatchObject({ configured: false, missingSettings: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] });
    expect(shopify({ ...domain, SHOPIFY_CLIENT_ID: "id" })).toMatchObject({ configured: false, missingSettings: ["SHOPIFY_CLIENT_SECRET"] });
    expect(shopify({ ...domain, SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "secret" })).toMatchObject({ configured: true, missingSettings: [] });
    expect(shopify({ ...domain, SHOPIFY_ADMIN_ACCESS_TOKEN: "token" })).toMatchObject({ configured: true, missingSettings: [] });
    expect(shopify({ SHOPIFY_ADMIN_ACCESS_TOKEN: "token" })).toMatchObject({ configured: false, missingSettings: ["SHOPIFY_SHOP_DOMAIN"] });
  });
});

