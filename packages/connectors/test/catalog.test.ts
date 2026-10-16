import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTEGRATIONS } from "@karatos/core";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const connectorDirs = readdirSync(src).filter((name) => statSync(src + name).isDirectory());

describe("built connectors and the catalog", () => {
  // The website, README and Console read the catalog, so a finished connector must be marked there.
  it("marks every connector in this package as built, with what it gives the business", () => {
    expect(connectorDirs).toContain("shopify");
    for (const id of connectorDirs) {
      const entry = INTEGRATIONS.find((i) => i.id === id);
      expect(entry, `${id} has no catalog entry`).toBeDefined();
      expect(entry!.status, id).toBe("built");
      expect(entry!.capabilities?.length ?? 0, id).toBeGreaterThan(0);
    }
  });

  it("has a connector here for every integration the catalog calls built", () => {
    const built = INTEGRATIONS.filter((i) => i.status === "built").map((i) => i.id);
    expect(built.filter((id) => !connectorDirs.includes(id))).toEqual([]);
  });
});
