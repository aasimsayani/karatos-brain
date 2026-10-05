import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATIONS, parseManifest } from "../src/index.js";

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
});
