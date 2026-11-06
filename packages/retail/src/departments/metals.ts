import { meltValueCents, TROY_OUNCE_GRAMS, type Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { ASSUMPTIONS, dollars, estimate, extractor, latestBySubject, pct, recommend, signalFrom, value } from "../department.js";
import { METALS } from "./inventory.js";

const MetalPriceUpdated = z.object({ metal: z.enum(METALS), spotPerTroyOunceCents: z.number().int().positive() });

const GoldPurchaseCompleted = z.object({
  purchaseId: z.string().min(1),
  sellerId: z.string().min(1),
  items: z
    .array(
      z.object({
        description: z.string().min(1),
        metal: z.enum(METALS),
        karat: z.number().int().min(1).max(24).optional(),
        weightGrams: z.number().positive(),
      }),
    )
    .min(1),
  paidCents: z.number().int().positive(),
  paymentMethod: z.enum(["cash", "check", "transfer", "store_credit"]),
  sellerIdVerified: z.boolean(),
});

const grams = z.number().positive();

/** One line of a refiner or scrap settlement statement, as the refiner statements connector writes it. */
const RefinerSettlementLine = z.object({
  lineId: z.string().min(1),
  refiner: z.string().min(1),
  lot: z.string().min(1),
  settledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metal: z.enum(METALS),
  grossGrams: grams.optional(),
  meltGrams: grams.optional(),
  fineness: z.number().positive().max(1).optional(),
  fineGrams: grams,
  fineTroyOunces: z.number().positive(),
  pricePerTroyOunceCents: z.number().int().positive().optional(),
  creditCents: z.number().int().optional(),
  feeCents: z.number().int().nonnegative().optional(),
  netCents: z.number().int().optional(),
  fineWeightCheck: z.enum(["matches", "differs", "not_checked"]),
  expectedFineGrams: z.number().nonnegative().optional(),
});

type Purchase = z.infer<typeof GoldPurchaseCompleted>;
type Settlement = z.infer<typeof RefinerSettlementLine>;
const PRICE_MOVE = 0.05;
const THIN_MARGIN = 0.85;
/** Refiners commonly pay 95 to 99 percent of spot on fine metal; under 90 is worth a second quote. */
const LOW_PAYABLE = 0.9;
/** A spot price older than this says little about the settlement day. */
const SPOT_MAX_AGE_MS = 7 * 86_400_000;

const g = (n: number) => `${n.toFixed(2)} g`;
const percent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

function pricesFor(signals: Signal[], metal: string): Signal[] {
  return signals
    .filter((s) => s.kind === "metal.price" && value<{ metal: string }>(s).metal === metal)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

/**
 * Metals: spot prices, and buying gold and silver from the public.
 * Spot prices also feed inventory valuation.
 */
export const metals: DepartmentModule = {
  id: "metals",
  name: "Metals and Gold Buying",
  purpose: "Spot prices, buying gold and silver from customers, and keeping prices in step with the market.",
  events: { "metal.price_updated": MetalPriceUpdated, "gold_purchase.completed": GoldPurchaseCompleted, "refining.settlement_line_imported": RefinerSettlementLine },
  normalizers: [],
  extractors: [
    extractor("metal-signals", (event) => {
      if (event.type === "metal.price_updated") {
        const p = MetalPriceUpdated.parse(event.payload);
        return [signalFrom(event, "metal.price", { kind: "metal", id: p.metal }, { ...p })];
      }
      if (event.type === "gold_purchase.completed") {
        const p = GoldPurchaseCompleted.parse(event.payload);
        return [signalFrom(event, "gold_purchase", { kind: "gold_purchase", id: p.purchaseId }, { ...p })];
      }
      if (event.type === "refining.settlement_line_imported") {
        const p = RefinerSettlementLine.parse(event.payload);
        return [signalFrom(event, "refining.settlement", { kind: "refiner_lot", id: p.lineId }, { ...p })];
      }
      return [];
    }),
  ],
  reasoners: [
    {
      name: "metals.price-move",
      reason: ({ organizationId, signals, now }) =>
        METALS.flatMap((metal) => {
          const prices = pricesFor(signals, metal);
          if (prices.length < 2) return [];
          const [before, after] = prices.slice(-2) as [Signal, Signal];
          const from = value<{ spotPerTroyOunceCents: number }>(before).spotPerTroyOunceCents;
          const to = value<{ spotPerTroyOunceCents: number }>(after).spotPerTroyOunceCents;
          const change = (to - from) / from;
          if (Math.abs(change) < PRICE_MOVE) return [];
          const pieces = signals.filter((s) => s.kind === "inventory.received" && value<{ metal?: string }>(s).metal === metal);
          const direction = change > 0 ? "up" : "down";
          // On a rise, the added metal value of the pieces in stock is margin to keep by repricing.
          const added = pieces.reduce((sum, s) => {
            const p = value<{ karat?: number; weightGrams?: number; quantity?: number }>(s);
            if (!p.weightGrams || (metal === "gold" && !p.karat)) return sum;
            const melt = (spot: number) => meltValueCents({ metal, ...(p.karat ? { karat: p.karat } : {}), weightGrams: p.weightGrams!, spotPerTroyOunceCents: spot });
            return sum + (melt(to) - melt(from)) * (p.quantity ?? 1);
          }, 0);
          return [
            recommend({
              department: "metals",
              key: `move_${metal}`,
              organizationId,
              summary: `${metal[0]!.toUpperCase()}${metal.slice(1)} is ${direction} ${Math.abs(Math.round(change * 1000) / 10)}% (${dollars(from)} to ${dollars(to)} per ounce). Review prices on ${pieces.length} ${metal} pieces and your buy-from-public rates.`,
              confidence: 0.8,
              expectedImpact: change > 0 ? "Protects margin on metal-heavy pieces" : "Keeps prices competitive",
              impact:
                change > 0
                  ? estimate("makes", `The ${dollars(added)} rise in metal value of the ${metal} pieces received with a weight, kept by raising their prices with the metal.`, () => added)
                  : undefined,
              basedOn: [before, after, ...pieces],
              now,
            }),
          ];
        }),
    },
    {
      name: "metals.buy-margin",
      reason: ({ organizationId, signals, now }) =>
        signals
          .filter((s) => s.kind === "gold_purchase")
          .flatMap((s) => {
            const p = value<Purchase>(s);
            let melt = 0;
            const basedOn = [s];
            for (const item of p.items) {
              if (item.metal === "gold" && !item.karat) return [];
              const spot = pricesFor(signals, item.metal).filter((x) => x.observedAt <= s.observedAt).at(-1);
              if (!spot) return [];
              basedOn.push(spot);
              melt += meltValueCents({
                metal: item.metal,
                ...(item.karat ? { karat: item.karat } : {}),
                weightGrams: item.weightGrams,
                spotPerTroyOunceCents: value<{ spotPerTroyOunceCents: number }>(spot).spotPerTroyOunceCents,
              });
            }
            if (melt === 0 || p.paidCents <= melt * THIN_MARGIN) return [];
            return [
              recommend({
                department: "metals",
                key: `margin_${p.purchaseId}`,
                organizationId,
                summary: `Gold purchase ${p.purchaseId} paid ${dollars(p.paidCents)} for metal worth about ${dollars(melt)} at spot (${Math.round((p.paidCents / melt) * 100)}%). Check your buy rates and scale calibration.`,
                confidence: 0.75,
                expectedImpact: "Protects margin on scrap and refining",
                impact: estimate(
                  "saves",
                  `Paid ${dollars(p.paidCents - Math.round(melt * THIN_MARGIN))} above ${pct(THIN_MARGIN)} of melt, saved on the next purchase like it.`,
                  () => p.paidCents - melt * THIN_MARGIN,
                ),
                basedOn: [...new Set(basedOn)],
                now,
              }),
            ];
          }),
    },
    {
      name: "metals.refiner-assay",
      reason: ({ organizationId, signals, now }) =>
        [...latestBySubject(signals, ["refining.settlement"]).values()].flatMap((s) => {
          const p = value<Settlement>(s);
          const basis = p.meltGrams ?? p.grossGrams;
          if (p.fineWeightCheck !== "differs" || basis === undefined || p.fineness === undefined || p.expectedFineGrams === undefined) return [];
          // Credited more than the assay says is the refiner's loss, not the store's.
          if (p.fineGrams >= p.expectedFineGrams) return [];
          // The short metal at the rate this settlement paid, when it says what that was.
          const perGram = p.pricePerTroyOunceCents ? p.pricePerTroyOunceCents / TROY_OUNCE_GRAMS : p.creditCents ? p.creditCents / p.fineGrams : undefined;
          const short = p.expectedFineGrams - p.fineGrams;
          return [
            recommend({
              department: "metals",
              key: `assay_${p.lineId}`,
              organizationId,
              summary: `Lot ${p.lot} from ${p.refiner} credits ${g(p.fineGrams)} of fine ${p.metal}, but ${g(basis)} at ${percent(p.fineness)} is ${g(p.expectedFineGrams)}. Ask the refiner to recheck the assay on the ${g(p.expectedFineGrams - p.fineGrams)} short.`,
              confidence: 0.8,
              expectedImpact: "Recovers metal credited short on a settlement",
              impact:
                perGram === undefined
                  ? undefined
                  : estimate("protects", `${g(short)} of fine ${p.metal} at the ${dollars(perGram)} a gram this settlement paid.`, () => short * perGram),
              basedOn: [s],
              now,
            }),
          ];
        }),
    },
    {
      name: "metals.refiner-payable",
      reason: ({ organizationId, signals, now }) =>
        [...latestBySubject(signals, ["refining.settlement"]).values()].flatMap((s) => {
          const p = value<Settlement>(s);
          if (p.creditCents === undefined || p.creditCents <= 0) return [];
          const endOfDay = `${p.settledOn}T23:59:59.999Z`;
          const spot = pricesFor(signals, p.metal).filter((x) => x.observedAt <= endOfDay).at(-1);
          if (!spot || Date.parse(endOfDay) - Date.parse(spot.observedAt) > SPOT_MAX_AGE_MS) return [];
          const spotCents = value<{ spotPerTroyOunceCents: number }>(spot).spotPerTroyOunceCents;
          const paid = p.creditCents / p.fineTroyOunces / spotCents;
          if (paid >= LOW_PAYABLE) return [];
          const fees = p.feeCents ? `, before ${dollars(p.feeCents)} in fees` : "";
          return [
            recommend({
              department: "metals",
              key: `payable_${p.lineId}`,
              organizationId,
              summary: `Lot ${p.lot} from ${p.refiner} paid ${dollars(p.creditCents)} for ${p.fineTroyOunces} oz of fine ${p.metal}, ${percent(paid)} of spot on ${p.settledOn}${fees}. Get a second quote on payable rates and fees.`,
              confidence: 0.7,
              expectedImpact: "Raises what scrap and refining bring in",
              impact: estimate(
                "makes",
                `This lot at ${pct(ASSUMPTIONS.targetPayable.likely)} of spot instead of ${percent(paid)}: ${p.fineTroyOunces} oz of fine ${p.metal} at ${dollars(spotCents)} an ounce.`,
                (a) => (a("targetPayable") - paid) * p.fineTroyOunces * spotCents,
              ),
              basedOn: [s, spot],
              now,
            }),
          ];
        }),
    },
  ],
};
