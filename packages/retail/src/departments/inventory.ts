import { meltValueCents, type Metal, type Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, entityFrom, extractor, recommend, signalFrom, value } from "../department.js";

export const CATEGORIES = ["ring", "engagement_ring", "wedding_band", "necklace", "pendant", "earrings", "bracelet", "watch", "loose_stone", "other"] as const;
export const METALS = ["gold", "silver", "platinum", "palladium"] as const;

const InventoryReceived = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(CATEGORIES),
  metal: z.enum(METALS).optional(),
  karat: z.number().int().min(1).max(24).optional(),
  weightGrams: z.number().positive().optional(),
  costCents: z.number().int().nonnegative(),
  retailPriceCents: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
  vendorId: z.string().optional(),
  onMemo: z.boolean().default(false),
});

const InventoryAdjusted = z.object({
  sku: z.string().min(1),
  delta: z.number().int(),
  reason: z.enum(["count", "damage", "theft", "sent_to_repair", "returned_to_vendor", "other"]),
});

type Received = z.infer<typeof InventoryReceived>;

const AGED_AFTER_DAYS = 270;

interface StockLine {
  sku: string;
  received: Signal[];
  onHand: number;
  soldRecently: number;
  lastSale?: string;
  basedOn: Signal[];
}

/** On-hand position per SKU, reconstructed from receipts, sales, returns and adjustments. */
function stockPositions(signals: Signal[], now: string): Map<string, StockLine> {
  const lines = new Map<string, StockLine>();
  const line = (sku: string) => {
    let l = lines.get(sku);
    if (!l) lines.set(sku, (l = { sku, received: [], onHand: 0, soldRecently: 0, basedOn: [] }));
    return l;
  };
  for (const s of signals) {
    const v = value<{ sku: string; quantity?: number; delta?: number }>(s);
    if (!v.sku) continue;
    switch (s.kind) {
      case "inventory.received":
        line(v.sku).received.push(s);
        line(v.sku).onHand += v.quantity ?? 0;
        break;
      case "inventory.adjusted":
        line(v.sku).onHand += v.delta ?? 0;
        break;
      case "sale.line": {
        const l = line(v.sku);
        l.onHand -= v.quantity ?? 0;
        if (daysBetween(s.observedAt, now) <= 60) l.soldRecently += v.quantity ?? 0;
        if (!l.lastSale || s.observedAt > l.lastSale) l.lastSale = s.observedAt;
        break;
      }
      case "sale.return_line":
        line(v.sku).onHand += v.quantity ?? 0;
        break;
      default:
        continue;
    }
    line(v.sku).basedOn.push(s);
  }
  return lines;
}

function latestSpot(signals: Signal[], metal: Metal): Signal | undefined {
  return signals
    .filter((s) => s.kind === "metal.price" && value<{ metal: string }>(s).metal === metal)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    .at(-1);
}

/**
 * Inventory and merchandising: what is in the case, what sells, what sits.
 * Uses the metals department's spot prices to value aged gold pieces.
 */
export const inventory: DepartmentModule = {
  id: "inventory",
  name: "Inventory and Merchandising",
  purpose: "What's in the cases and the safe, what sells, what sits, and when to reorder, mark down or remake.",
  events: { "inventory.received": InventoryReceived, "inventory.adjusted": InventoryAdjusted },
  normalizers: [
    entityFrom<Received>("inventory-products", "inventory.received", (p) => ({
      ref: { kind: "product", id: p.sku },
      attributes: { ...p },
    })),
  ],
  extractors: [
    extractor("inventory-signals", (event) => {
      if (event.type === "inventory.received") {
        const p = InventoryReceived.parse(event.payload);
        return [signalFrom(event, "inventory.received", { kind: "product", id: p.sku }, { ...p })];
      }
      if (event.type === "inventory.adjusted") {
        const p = InventoryAdjusted.parse(event.payload);
        return [signalFrom(event, "inventory.adjusted", { kind: "product", id: p.sku }, { ...p })];
      }
      return [];
    }),
  ],
  reasoners: [
    {
      name: "inventory.aged-stock",
      reason: ({ organizationId, signals, now }) =>
        [...stockPositions(signals, now).values()].flatMap((line) => {
          const first = line.received.sort((a, b) => a.observedAt.localeCompare(b.observedAt))[0];
          if (!first || line.onHand <= 0) return [];
          const p = value<Received>(first);
          if (p.onMemo) return [];
          const age = daysBetween(first.observedAt, now);
          const sinceSale = line.lastSale ? daysBetween(line.lastSale, now) : age;
          if (age < AGED_AFTER_DAYS || sinceSale < AGED_AFTER_DAYS) return [];

          const basedOn = [...line.basedOn];
          let meltNote = "";
          if (p.metal && p.weightGrams && (p.metal !== "gold" || p.karat)) {
            const spot = latestSpot(signals, p.metal);
            if (spot) {
              basedOn.push(spot);
              const melt = meltValueCents({
                metal: p.metal,
                ...(p.karat ? { karat: p.karat } : {}),
                weightGrams: p.weightGrams,
                spotPerTroyOunceCents: value<{ spotPerTroyOunceCents: number }>(spot).spotPerTroyOunceCents,
              });
              meltNote =
                melt >= p.costCents * 0.85
                  ? ` Its metal alone is worth about ${dollars(melt)} against a cost of ${dollars(p.costCents)}, so remaking it is an option.`
                  : ` Metal value is about ${dollars(melt)}.`;
            }
          }
          return [
            recommend({
              department: "inventory",
              key: `aged_${line.sku}`,
              organizationId,
              summary: `${p.title} (${line.sku}) has sat for ${sinceSale} days with ${line.onHand} on hand. Feature it, move it to another case or channel, or mark it down.${meltNote}`,
              confidence: 0.7,
              expectedImpact: `Frees ${dollars(p.costCents * line.onHand)} of cost tied up in slow stock`,
              basedOn,
              now,
            }),
          ];
        }),
    },
    {
      name: "inventory.reorder",
      reason: ({ organizationId, signals, now }) =>
        [...stockPositions(signals, now).values()]
          .filter((line) => line.received.length > 0 && line.onHand <= 1 && line.soldRecently >= 2)
          .flatMap((line) => {
            const p = value<Received>(line.received.at(-1)!);
            if (p.onMemo || p.category === "loose_stone") return [];
            return [
              recommend({
                department: "inventory",
                key: `reorder_${line.sku}`,
                organizationId,
                summary: `Reorder ${p.title} (${line.sku}): ${line.soldRecently} sold in the last 60 days and ${Math.max(line.onHand, 0)} left.`,
                confidence: Math.min(0.9, 0.55 + line.soldRecently * 0.05),
                expectedImpact: `Avoids missing sales at ${dollars(p.retailPriceCents)} each`,
                basedOn: line.basedOn,
                now,
              }),
            ];
          }),
    },
  ],
};
