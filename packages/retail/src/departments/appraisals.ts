import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, entityFrom, extractor, recommend, signalFrom, value } from "../department.js";

const AppraisalCompleted = z.object({
  appraisalId: z.string().min(1),
  customerId: z.string().min(1),
  itemDescription: z.string().min(1),
  appraisedValueCents: z.number().int().positive(),
  purpose: z.enum(["insurance", "estate", "resale", "donation", "other"]),
});

type Appraisal = z.infer<typeof AppraisalCompleted>;
const UPDATE_AFTER_DAYS = 3 * 365;

/** Appraisals, and the insurance updates they should lead to. */
export const appraisals: DepartmentModule = {
  id: "appraisals",
  name: "Appraisals",
  purpose: "Insurance, estate and resale appraisals, and keeping insured values current.",
  events: { "appraisal.completed": AppraisalCompleted },
  normalizers: [
    entityFrom<Appraisal>("appraisals", "appraisal.completed", (p) => ({
      ref: { kind: "appraisal", id: p.appraisalId },
      attributes: { ...p },
    })),
  ],
  extractors: [
    extractor("appraisal-signals", (event) => {
      if (event.type !== "appraisal.completed") return [];
      const p = AppraisalCompleted.parse(event.payload);
      return [signalFrom(event, "appraisal.completed", { kind: "appraisal", id: p.appraisalId }, { ...p })];
    }),
  ],
  reasoners: [
    {
      name: "appraisals.insurance-update",
      reason: ({ organizationId, signals, now }) =>
        signals
          .filter((s) => s.kind === "appraisal.completed")
          .flatMap((s) => {
            const a = value<Appraisal>(s);
            const age = daysBetween(s.observedAt, now);
            if (a.purpose !== "insurance" || age < UPDATE_AFTER_DAYS) return [];
            return [
              recommend({
                department: "appraisals",
                key: `update_${a.appraisalId}`,
                organizationId,
                summary: `The insurance appraisal for ${a.itemDescription} (${dollars(a.appraisedValueCents)}) is ${Math.floor(age / 365)} years old. Offer the customer an update so they aren't underinsured.`,
                confidence: 0.7,
                expectedImpact: "Appraisal fee, and a reason for the customer to visit",
                basedOn: [s],
                now,
              }),
            ];
          }),
    },
  ],
};
