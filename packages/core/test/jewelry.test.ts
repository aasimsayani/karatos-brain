import { describe, expect, it } from "vitest";
import { meltValueCents, purity } from "../src/index.js";

describe("purity", () => {
  it("derives gold fineness from karat", () => {
    expect(purity("gold", 24)).toBe(1);
    expect(purity("gold", 18)).toBe(0.75);
    expect(purity("gold", 14)).toBeCloseTo(0.5833, 4);
  });

  it("requires a valid karat for gold", () => {
    expect(() => purity("gold")).toThrow(RangeError);
    expect(() => purity("gold", 25)).toThrow(RangeError);
  });

  it("uses sterling fineness for silver", () => {
    expect(purity("silver")).toBe(0.925);
  });
});

describe("meltValueCents", () => {
  it("prices one troy ounce of 24k gold at spot", () => {
    expect(
      meltValueCents({ metal: "gold", karat: 24, weightGrams: 31.1034768, spotPerTroyOunceCents: 250_000 }),
    ).toBe(250_000);
  });

  it("scales by karat and weight", () => {
    // 10g of 14k at $2,500/ozt: 10 * 14/24 / 31.1034768 * 2500 = $468.87
    expect(meltValueCents({ metal: "gold", karat: 14, weightGrams: 10, spotPerTroyOunceCents: 250_000 })).toBe(46_887);
  });
});
