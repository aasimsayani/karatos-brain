import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { repoDocuments } from "../src/index.js";

// A folder may list its files in any order; this one lists them backwards.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, readdir: (async (...args: Parameters<typeof real.readdir>) => ((await real.readdir(...args)) as unknown[]).reverse()) as typeof real.readdir };
});

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("repoDocuments", () => {
  it("lists documents in path order whatever order the folder gives them", async () => {
    dir = await mkdtemp(join(tmpdir(), "docs-order-"));
    for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(dir, name), `# ${name}`);
    expect((await repoDocuments(dir)).map((d) => d.id)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
  });
});
