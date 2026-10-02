import type { Metal } from "./entities.js";

const TROY_OUNCE_GRAMS = 31.1034768;

/** Fineness of common precious-metal alloys, as a fraction of pure metal. */
export function purity(metal: Metal, karat?: number): number {
  switch (metal) {
    case "gold":
      if (karat === undefined || karat <= 0 || karat > 24) {
        throw new RangeError("gold needs a karat between 1 and 24");
      }
      return karat / 24;
    case "silver":
      return 0.925;
    case "platinum":
      return 0.95;
    case "palladium":
      return 0.95;
  }
}

/**
 * Melt value of a piece in cents, from its weight and the spot price of the
 * pure metal per troy ounce (also in cents).
 */
export function meltValueCents(input: {
  metal: Metal;
  karat?: number;
  weightGrams: number;
  spotPerTroyOunceCents: number;
}): number {
  if (input.weightGrams < 0) throw new RangeError("weightGrams must be non-negative");
  const pureGrams = input.weightGrams * purity(input.metal, input.karat);
  return Math.round((pureGrams / TROY_OUNCE_GRAMS) * input.spotPerTroyOunceCents);
}
