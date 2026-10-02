import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { calendarDaysSince, daysBetween, entityFrom, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

export const REPAIR_STATUSES = ["received", "at_bench", "sent_out", "ready", "picked_up", "cancelled"] as const;
type RepairStatus = (typeof REPAIR_STATUSES)[number];

const RepairReceived = z.object({
  ticketId: z.string().min(1),
  customerId: z.string().min(1),
  itemDescription: z.string().min(1),
  work: z.string().min(1),
  promisedBy: z.iso.date(),
  estimateCents: z.number().int().nonnegative(),
  declaredValueCents: z.number().int().nonnegative().optional(),
});

const RepairStatusChanged = z.object({ ticketId: z.string().min(1), status: z.enum(REPAIR_STATUSES) });

type Ticket = z.infer<typeof RepairReceived>;
const OPEN: RepairStatus[] = ["received", "at_bench", "sent_out"];
const READY_REMINDER_DAYS = 30;
const UNCLAIMED_REVIEW_DAYS = 180;

/** Repairs and service: every ticket from intake to pickup. */
export const repairs: DepartmentModule = {
  id: "repairs",
  name: "Repairs and Service",
  purpose: "Every repair ticket from intake to pickup, so nothing is late or forgotten in the safe.",
  events: { "repair.received": RepairReceived, "repair.status_changed": RepairStatusChanged },
  normalizers: [
    entityFrom<Ticket>("repair-tickets", "repair.received", (p) => ({
      ref: { kind: "repair_ticket", id: p.ticketId },
      attributes: { ...p, status: "received" },
    })),
  ],
  extractors: [
    extractor("repair-signals", (event) => {
      const ref = (id: string) => ({ kind: "repair_ticket", id });
      if (event.type === "repair.received") {
        const p = RepairReceived.parse(event.payload);
        return [
          signalFrom(event, "repair.ticket", ref(p.ticketId), { ...p }),
          signalFrom(event, "repair.status", ref(p.ticketId), { status: "received" }),
        ];
      }
      if (event.type === "repair.status_changed") {
        const p = RepairStatusChanged.parse(event.payload);
        return [signalFrom(event, "repair.status", ref(p.ticketId), { status: p.status })];
      }
      return [];
    }),
  ],
  reasoners: [
    {
      name: "repairs.follow-up",
      reason: ({ organizationId, signals, now }) => {
        const tickets = latestBySubject(signals, ["repair.ticket"]);
        const statuses = latestBySubject(signals, ["repair.status"]);
        return [...tickets.entries()].flatMap(([key, ticketSignal]) => {
          const statusSignal = statuses.get(key);
          if (!statusSignal) return [];
          const t = value<Ticket>(ticketSignal);
          const status = value<{ status: RepairStatus }>(statusSignal).status;
          const basedOn = [ticketSignal, statusSignal];
          const base = { department: "repairs", organizationId, basedOn, now };

          if (OPEN.includes(status)) {
            const late = calendarDaysSince(t.promisedBy, now);
            if (late <= 0) return [];
            return [
              recommend({
                ...base,
                key: `late_${t.ticketId}`,
                summary: `Repair ${t.ticketId} (${t.itemDescription}) is ${late} days past its promised date and still ${status.replace("_", " ")}. Call the customer with an update today.`,
                confidence: 0.9,
                expectedImpact: "Keeps the customer's trust on a late repair",
              }),
            ];
          }
          if (status === "ready") {
            const waiting = daysBetween(statusSignal.observedAt, now);
            if (waiting >= UNCLAIMED_REVIEW_DAYS) {
              return [
                recommend({
                  ...base,
                  key: `unclaimed_${t.ticketId}`,
                  summary: `Repair ${t.ticketId} has been ready for ${waiting} days. Send a written final notice and follow your state's rules for unclaimed property before taking any other action.`,
                  confidence: 0.7,
                  expectedImpact: "Clears the safe and limits liability for unclaimed items",
                }),
              ];
            }
            if (waiting >= READY_REMINDER_DAYS) {
              return [
                recommend({
                  ...base,
                  key: `pickup_${t.ticketId}`,
                  summary: `Repair ${t.ticketId} (${t.itemDescription}) has been ready for ${waiting} days. Remind the customer to pick it up.`,
                  confidence: 0.85,
                  expectedImpact: "Collects the repair payment and frees safe space",
                }),
              ];
            }
          }
          return [];
        });
      },
    },
  ],
};
