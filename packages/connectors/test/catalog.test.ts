import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTEGRATIONS } from "@karatos/core";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src/", import.meta.url));
/** Shared code for several connectors, not a connector itself. */
const SHARED_DIRS = ["files"];
const connectorDirs = readdirSync(src).filter((name) => statSync(src + name).isDirectory() && !SHARED_DIRS.includes(name));

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

  it("keeps shared code out of the connector list", () => {
    for (const dir of SHARED_DIRS) expect(INTEGRATIONS.some((i) => i.id === dir), dir).toBe(false);
  });

  it("has a connector here for every integration the catalog calls built", () => {
    const built = INTEGRATIONS.filter((i) => i.status === "built").map((i) => i.id);
    expect(built.filter((id) => !connectorDirs.includes(id))).toEqual([]);
  });
});
