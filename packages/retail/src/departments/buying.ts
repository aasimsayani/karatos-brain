import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { calendarDaysSince, dollars, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

const MemoReceived = z.object({
  memoId: z.string().min(1),
  vendorId: z.string().min(1),
  sku: z.string().min(1),
  costCents: z.number().int().positive(),
  dueBack: z.iso.date(),
});
const MemoSettled = z.object({ memoId: z.string().min(1), outcome: z.enum(["returned", "purchased"]) });
const PurchaseOrderCreated = z.object({
  poId: z.string().min(1),
  vendorId: z.string().min(1),
  expectedBy: z.iso.date(),
  totalCents: z.number().int().nonnegative(),
});
const PurchaseOrderReceived = z.object({ poId: z.string().min(1) });

type Memo = z.infer<typeof MemoReceived>;
type PurchaseOrder = z.infer<typeof PurchaseOrderCreated>;
const MEMO_WARNING_DAYS = 14;

/** Buying, vendors and memo (consignment) goods. */
export const buying: DepartmentModule = {
  id: "buying",
  name: "Buying, Vendors and Memo",
  purpose: "Purchase orders, vendor reliability, and memo goods that must be paid for or returned on time.",
  events: {
    "memo.received": MemoReceived,
    "memo.settled": MemoSettled,
    "purchase_order.created": PurchaseOrderCreated,
    "purchase_order.received": PurchaseOrderReceived,
  },
  normalizers: [],
  extractors: [
    extractor("buying-signals", (event) => {
      switch (event.type) {
        case "memo.received": {
          const p = MemoReceived.parse(event.payload);
          return [signalFrom(event, "memo.open", { kind: "memo", id: p.memoId }, { ...p })];
        }
        case "memo.settled": {
          const p = MemoSettled.parse(event.payload);
          return [signalFrom(event, "memo.settled", { kind: "memo", id: p.memoId }, { ...p })];
        }
        case "purchase_order.created": {
          const p = PurchaseOrderCreated.parse(event.payload);
          return [signalFrom(event, "po.open", { kind: "purchase_order", id: p.poId }, { ...p })];
        }
        case "purchase_order.received": {
          const p = PurchaseOrderReceived.parse(event.payload);
          return [signalFrom(event, "po.received", { kind: "purchase_order", id: p.poId }, { ...p })];
        }
        default:
          return [];
      }
    }),
  ],
  reasoners: [
    {
      name: "buying.memo-due",
      reason: ({ organizationId, signals, now }) => {
        const settled = latestBySubject(signals, ["memo.settled"]);
        const sold = new Set(signals.filter((s) => s.kind === "sale.line").map((s) => value<{ sku: string }>(s).sku));
        return [...latestBySubject(signals, ["memo.open"]).entries()].flatMap(([key, s]) => {
          if (settled.has(key)) return [];
          const m = value<Memo>(s);
          const daysLeft = -calendarDaysSince(m.dueBack, now);
          if (daysLeft > MEMO_WARNING_DAYS) return [];
          const when = daysLeft < 0 ? `was due back ${-daysLeft} days ago` : `is due back in ${daysLeft} days`;
          const action = sold.has(m.sku)
            ? `It has sold, so settle the memo and pay ${dollars(m.costCents)}.`
            : `It hasn't sold. Return it, or buy it for ${dollars(m.costCents)} if you want to keep it.`;
          return [
            recommend({
              department: "buying",
              key: `memo_${m.memoId}`,
              organizationId,
              summary: `Memo ${m.memoId} (${m.sku}) from ${m.vendorId} ${when}. ${action}`,
              confidence: 0.9,
              expectedImpact: "Keeps vendor terms and avoids paying for goods by default",
              basedOn: [s],
              now,
            }),
          ];
        });
      },
    },
    {
      name: "buying.late-purchase-orders",
      reason: ({ organizationId, signals, now }) => {
        const received = latestBySubject(signals, ["po.received"]);
        return [...latestBySubject(signals, ["po.open"]).entries()].flatMap(([key, s]) => {
          if (received.has(key)) return [];
          const po = value<PurchaseOrder>(s);
          const late = calendarDaysSince(po.expectedBy, now);
          if (late <= 0) return [];
          return [
            recommend({
              department: "buying",
              key: `late_po_${po.poId}`,
              organizationId,
              summary: `Purchase order ${po.poId} from ${po.vendorId} (${dollars(po.totalCents)}) is ${late} days late. Follow up with the vendor.`,
              confidence: 0.85,
              expectedImpact: "Keeps stock arriving in time to sell",
              basedOn: [s],
              now,
            }),
          ];
        });
      },
    },
  ],
};
