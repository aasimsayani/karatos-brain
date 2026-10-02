import { meltValueCents, type Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { dollars, extractor, recommend, signalFrom, value } from "../department.js";
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

type Purchase = z.infer<typeof GoldPurchaseCompleted>;
const PRICE_MOVE = 0.05;
const THIN_MARGIN = 0.85;

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
  events: { "metal.price_updated": MetalPriceUpdated, "gold_purchase.completed": GoldPurchaseCompleted },
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
          return [
            recommend({
              department: "metals",
              key: `move_${metal}`,
              organizationId,
              summary: `${metal[0]!.toUpperCase()}${metal.slice(1)} is ${direction} ${Math.abs(Math.round(change * 1000) / 10)}% (${dollars(from)} to ${dollars(to)} per ounce). Review prices on ${pieces.length} ${metal} pieces and your buy-from-public rates.`,
              confidence: 0.8,
              expectedImpact: change > 0 ? "Protects margin on metal-heavy pieces" : "Keeps prices competitive",
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
                basedOn: [...new Set(basedOn)],
                now,
              }),
            ];
          }),
    },
  ],
};
