import { z } from "zod";
import type { Signal } from "@karatos/core";
import type { DepartmentModule } from "../department.js";
import { calendarDaysSince, daysBetween, dollars, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

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
/** A dealer's offer seen in the trade's WhatsApp groups, such as through TheWatchSearch. Dealers are keyed hashes; the group is the name the store gave its export. */
const WatchOfferSeen = z
  .object({
    offerId: z.string().min(1),
    side: z.enum(["selling", "looking_for"]),
    brand: z.string().min(1),
    reference: z.string().min(1),
    priceMinor: z.number().int().positive().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    year: z.number().int().min(1900).max(2100).optional(),
    condition: z.enum(["new", "pre_owned"]).optional(),
    set: z.enum(["full_set", "watch_only", "box_only", "papers_only"]).optional(),
    dealerRef: z.string().min(1),
    group: z.string().min(1),
  })
  .refine((p) => (p.priceMinor === undefined) === (p.currency === undefined), { message: "a price needs its currency, and a currency its price" });

type Memo = z.infer<typeof MemoReceived>;
type PurchaseOrder = z.infer<typeof PurchaseOrderCreated>;
type WatchOffer = z.infer<typeof WatchOfferSeen>;
const MEMO_WARNING_DAYS = 14;
/** How far back the trade's offers count, and how many dealers looking for one reference make it worth acting on. */
const WATCH_MARKET_DAYS = 14;
const WATCH_WANTED_DEALERS = 3;

const money = (minor: number, currency: string) =>
  currency === "USD" ? dollars(minor) : (minor / 100).toLocaleString("en-US", { style: "currency", currency });

/** The lowest asking price per currency, most offers first, as "$14,500.00 (lowest of 4 asks)". */
function lowestAsks(offers: WatchOffer[]): string | null {
  const byCurrency = new Map<string, number[]>();
  for (const o of offers) if (o.side === "selling" && o.priceMinor && o.currency) byCurrency.set(o.currency, [...(byCurrency.get(o.currency) ?? []), o.priceMinor]);
  const [best] = [...byCurrency.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  if (!best) return null;
  const [currency, prices] = best;
  return `${money(Math.min(...prices), currency)} (lowest of ${prices.length} ${prices.length === 1 ? "ask" : "asks"})`;
}

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
    "watch_market.offer_seen": WatchOfferSeen,
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
        case "watch_market.offer_seen": {
          const p = WatchOfferSeen.parse(event.payload);
          return [signalFrom(event, "watch.offer", { kind: "watch_reference", id: `${p.brand}|${p.reference}` }, { ...p })];
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
    {
      name: "buying.watch-wanted",
      reason: ({ organizationId, signals, now }) => {
        const recent = signals.filter((s) => s.kind === "watch.offer" && daysBetween(s.observedAt, now) < WATCH_MARKET_DAYS && s.observedAt <= now);
        const byReference = new Map<string, Signal[]>();
        for (const s of recent) byReference.set(s.subject.id, [...(byReference.get(s.subject.id) ?? []), s]);
        return [...byReference.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .flatMap(([id, offerSignals]) => {
            const offers = offerSignals.map((s) => value<WatchOffer>(s));
            const dealers = new Set(offers.filter((o) => o.side === "looking_for").map((o) => o.dealerRef));
            if (dealers.size < WATCH_WANTED_DEALERS) return [];
            const { brand, reference } = offers[0]!;
            const asks = lowestAsks(offers);
            const market = asks ? ` Dealers in the same groups are asking from ${asks}.` : "";
            return [
              recommend({
                department: "buying",
                key: `watch_wanted_${id.replace(/[^A-Za-z0-9]/g, "_")}`,
                organizationId,
                summary: `${dealers.size} dealers in your WhatsApp groups have asked for the ${brand} ${reference} in the last ${WATCH_MARKET_DAYS} days.${market} If you have one, or can source one, offer it to them.`,
                confidence: 0.7,
                expectedImpact: "Sells to dealers already looking, at today's trade price",
                basedOn: offerSignals,
                now,
              }),
            ];
          });
      },
    },
  ],
};
