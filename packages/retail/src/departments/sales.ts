import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { entityFrom, extractor, recommend, signalFrom, value } from "../department.js";

export const PAYMENT_METHODS = ["card", "cash", "check", "financing", "trade_in", "gift_card", "wire", "other"] as const;

const SaleCompleted = z.object({
  saleId: z.string().min(1),
  customerId: z.string().min(1).optional(),
  channel: z.enum(["store", "online", "phone", "event"]),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceCents: z.number().int().nonnegative(),
        discountCents: z.number().int().nonnegative().default(0),
      }),
    )
    .min(1),
  totalCents: z.number().int().nonnegative(),
  payments: z.array(z.object({ method: z.enum(PAYMENT_METHODS), amountCents: z.number().int().positive() })).min(1),
  salespersonId: z.string().optional(),
});

const SaleReturned = z.object({
  saleId: z.string().min(1),
  returnId: z.string().min(1),
  lines: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().positive(), refundCents: z.number().int().nonnegative() })).min(1),
  reason: z.string().optional(),
});

export type SaleCompletedPayload = z.infer<typeof SaleCompleted>;

/**
 * Sales and point of sale, in store and online. Its signals feed inventory
 * (sell-through), clienteling (lifetime value) and compliance (cash).
 */
export const sales: DepartmentModule = {
  id: "sales",
  name: "Sales and POS",
  purpose: "Every sale and return, across the counter, website, phone and trunk shows.",
  events: { "sale.completed": SaleCompleted, "sale.returned": SaleReturned },
  normalizers: [
    entityFrom<SaleCompletedPayload>("sales-orders", "sale.completed", (p) => ({
      ref: { kind: "order", id: p.saleId },
      attributes: { channel: p.channel, totalCents: p.totalCents, customerId: p.customerId ?? null, lines: p.lines },
    })),
  ],
  extractors: [
    extractor("sales-signals", (event) => {
      if (event.type === "sale.completed") {
        const p = SaleCompleted.parse(event.payload);
        const lines = p.lines.map((line, part) =>
          signalFrom(
            event,
            "sale.line",
            { kind: "product", id: line.sku },
            { sku: line.sku, quantity: line.quantity, revenueCents: line.unitPriceCents * line.quantity - line.discountCents },
            { part },
          ),
        );
        const customer = p.customerId
          ? [signalFrom(event, "sale.customer_purchase", { kind: "customer", id: p.customerId }, { saleId: p.saleId, totalCents: p.totalCents })]
          : [];
        const cash = p.payments
          .filter((pay) => pay.method === "cash")
          .map((pay, i) =>
            signalFrom(event, "payment.cash_received", { kind: "order", id: `${p.saleId}#${i}` }, {
              saleId: p.saleId,
              customerId: p.customerId ?? null,
              amountCents: pay.amountCents,
            }),
          );
        return [...lines, ...customer, ...cash];
      }
      if (event.type === "sale.returned") {
        const p = SaleReturned.parse(event.payload);
        return p.lines.map((line, part) =>
          signalFrom(
            event,
            "sale.return_line",
            { kind: "product", id: line.sku },
            { sku: line.sku, quantity: line.quantity, refundCents: line.refundCents, reason: p.reason ?? null },
            { part },
          ),
        );
      }
      return [];
    }),
  ],
  reasoners: [
    {
      name: "sales.high-return-rate",
      reason: ({ organizationId, signals, now }) => {
        const bySku = new Map<string, { sold: number; returned: number; basedOn: typeof signals }>();
        for (const s of signals) {
          if (s.kind !== "sale.line" && s.kind !== "sale.return_line") continue;
          const v = value<{ sku: string; quantity: number }>(s);
          const row = bySku.get(v.sku) ?? { sold: 0, returned: 0, basedOn: [] };
          if (s.kind === "sale.line") row.sold += v.quantity;
          else row.returned += v.quantity;
          row.basedOn.push(s);
          bySku.set(v.sku, row);
        }
        return [...bySku.entries()]
          .filter(([, r]) => r.sold >= 4 && r.returned / r.sold >= 0.25)
          .map(([sku, r]) =>
            recommend({
              department: "sales",
              key: `returns_${sku}`,
              organizationId,
              summary: `${sku} has been returned ${r.returned} of ${r.sold} times (${Math.round((r.returned / r.sold) * 100)}%). Check its photos, description, sizing and build quality before restocking.`,
              confidence: Math.min(0.95, 0.5 + r.sold / 40),
              expectedImpact: "Fewer refunds and restocking costs",
              basedOn: r.basedOn,
              now,
            }),
          );
      },
    },
  ],
};
