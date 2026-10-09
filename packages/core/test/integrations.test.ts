import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS, integrationsFor, parseManifest, selfServeIntegrations } from "../src/index.js";

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
    const missing = INTEGRATIONS.flatMap((i) => i.settings.filter((s) => !documented.has(s)).map((s) => `${i.id}:${s}`));
    expect(missing).toEqual([]);
  });

  it("marks each integration's own secrets as needed only once it is enabled", () => {
    const byName = new Map(manifest.entries.map((e) => [e.name, e]));
    for (const integration of INTEGRATIONS) {
      for (const setting of integration.settings) {
        const entry = byName.get(setting)!;
        const scoped = entry.requiredFor.includes(`integration:${integration.id}`) || entry.requiredFor.includes("instance");
        expect(scoped, `${setting} should be required for integration:${integration.id}`).toBe(true);
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
