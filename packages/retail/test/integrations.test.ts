import { describe, expect, it } from "vitest";
import { INTEGRATIONS } from "@karatos/core";
import { MANUFACTURING_DEPARTMENTS } from "@karatos/manufacturing";
import { RETAIL_DEPARTMENTS } from "../src/index.js";

// Departments planned beyond retail; integrations may already feed them.
const PLANNED = ["manufacturing", "wholesale"];

describe("integrations by department", () => {
  it("names only departments that exist or are planned", () => {
    const known = new Set([...RETAIL_DEPARTMENTS, ...MANUFACTURING_DEPARTMENTS].map((d) => d.id).concat(PLANNED));
    const unknown = INTEGRATIONS.flatMap((i) => i.departments.filter((d) => !known.has(d)).map((d) => `${i.id}:${d}`));
    expect(unknown).toEqual([]);
  });

  it("gives every retail department at least two systems to read from", () => {
    const thin = RETAIL_DEPARTMENTS.filter((d) => INTEGRATIONS.filter((i) => i.departments.includes(d.id)).length < 2).map((d) => d.id);
    expect(thin).toEqual([]);
  });
});
