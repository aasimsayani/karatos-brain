import type { Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { calendarDaysSince, daysBetween, dollars, entityFrom, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

export const CUSTOM_STAGES = ["design", "cad", "approval", "casting", "setting", "finishing", "ready", "delivered", "cancelled"] as const;
type Stage = (typeof CUSTOM_STAGES)[number];

const CustomOrderCreated = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  description: z.string().min(1),
  quotedCents: z.number().int().positive(),
  dueBy: z.iso.date(),
});
const StageChanged = z.object({ orderId: z.string().min(1), stage: z.enum(CUSTOM_STAGES) });
const PaymentReceived = z.object({ orderId: z.string().min(1), amountCents: z.number().int().positive() });

type Order = z.infer<typeof CustomOrderCreated>;
const STALLED_AFTER_DAYS = 14;
const AT_RISK_DAYS = 7;
const DONE: Stage[] = ["ready", "delivered", "cancelled"];
const LATE_STAGES: Stage[] = ["finishing", ...DONE];

/** Custom design and special orders, from sketch to delivery. */
export const customOrders: DepartmentModule = {
  id: "custom_orders",
  name: "Custom and Special Orders",
  purpose: "Custom designs and special orders from first sketch to delivery, with deposits and deadlines.",
  events: {
    "custom_order.created": CustomOrderCreated,
    "custom_order.stage_changed": StageChanged,
    "custom_order.payment_received": PaymentReceived,
  },
  normalizers: [
    entityFrom<Order>("custom-orders", "custom_order.created", (p) => ({
      ref: { kind: "custom_order", id: p.orderId },
      attributes: { ...p, stage: "design" },
    })),
  ],
  extractors: [
    extractor("custom-order-signals", (event) => {
      const ref = (id: string) => ({ kind: "custom_order", id });
      switch (event.type) {
        case "custom_order.created": {
          const p = CustomOrderCreated.parse(event.payload);
          return [
            signalFrom(event, "custom.order", ref(p.orderId), { ...p }),
            signalFrom(event, "custom.stage", ref(p.orderId), { stage: "design" }),
          ];
        }
        case "custom_order.stage_changed": {
          const p = StageChanged.parse(event.payload);
          return [signalFrom(event, "custom.stage", ref(p.orderId), { stage: p.stage })];
        }
        case "custom_order.payment_received": {
          const p = PaymentReceived.parse(event.payload);
          return [signalFrom(event, "custom.payment", ref(p.orderId), { amountCents: p.amountCents })];
        }
        default:
          return [];
      }
    }),
  ],
  reasoners: [
    {
      name: "custom-orders.progress",
      reason: ({ organizationId, signals, now }) => {
        const orders = latestBySubject(signals, ["custom.order"]);
        const stages = latestBySubject(signals, ["custom.stage"]);
        const payments = new Map<string, Signal[]>();
        for (const s of signals.filter((s) => s.kind === "custom.payment")) {
          payments.set(s.subject.id, [...(payments.get(s.subject.id) ?? []), s]);
        }

        return [...orders.entries()].flatMap(([key, orderSignal]) => {
          const stageSignal = stages.get(key);
          if (!stageSignal) return [];
          const o = value<Order>(orderSignal);
          const stage = value<{ stage: Stage }>(stageSignal).stage;
          const paid = (payments.get(o.orderId) ?? []).reduce((sum, s) => sum + value<{ amountCents: number }>(s).amountCents, 0);
          const basedOn = [orderSignal, stageSignal, ...(payments.get(o.orderId) ?? [])];
          const base = { department: "custom_orders", organizationId, basedOn, now };
          const out = [];

          const inStage = daysBetween(stageSignal.observedAt, now);
          if (!DONE.includes(stage) && inStage >= STALLED_AFTER_DAYS) {
            out.push(
              recommend({
                ...base,
                key: `stalled_${o.orderId}`,
                summary: `Custom order ${o.orderId} (${o.description}) has been in ${stage} for ${inStage} days. Find out what's holding it up.`,
                confidence: 0.75,
                expectedImpact: "Keeps custom work moving toward its due date",
              }),
            );
          }
          const daysLeft = -calendarDaysSince(o.dueBy, now);
          if (!LATE_STAGES.includes(stage) && daysLeft <= AT_RISK_DAYS) {
            out.push(
              recommend({
                ...base,
                key: `at_risk_${o.orderId}`,
                summary: `Custom order ${o.orderId} ${daysLeft < 0 ? `was due ${-daysLeft} days ago` : `is due in ${daysLeft} days`} but is only at ${stage}. Tell the customer now or expedite the work.`,
                confidence: 0.85,
                expectedImpact: "Avoids a missed promise on a high-value order",
              }),
            );
          }
          if (stage === "ready" && paid < o.quotedCents) {
            out.push(
              recommend({
                ...base,
                key: `balance_${o.orderId}`,
                summary: `Custom order ${o.orderId} is ready with ${dollars(o.quotedCents - paid)} still due. Collect the balance when the customer picks it up.`,
                confidence: 0.9,
                expectedImpact: `Collects ${dollars(o.quotedCents - paid)}`,
              }),
            );
          }
          return out;
        });
      },
    },
  ],
};
