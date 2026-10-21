import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("tsconfig.base.json", () => {
  it("names the Node types itself, since TypeScript 6 and later no longer load every @types package by default", () => {
    const base = JSON.parse(readFileSync(new URL("../tsconfig.base.json", import.meta.url), "utf8")) as { compilerOptions: { types?: string[] } };
    expect(base.compilerOptions.types).toEqual(["node"]);
  });
});
