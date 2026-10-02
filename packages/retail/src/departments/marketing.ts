import type { Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, extractor, recommend, signalFrom, value } from "../department.js";

const CampaignSent = z.object({
  campaignId: z.string().min(1),
  name: z.string().min(1),
  channel: z.enum(["email", "sms", "instagram", "facebook", "google", "print", "event", "other"]),
  costCents: z.number().int().nonnegative(),
});
const CampaignAttributed = z.object({ campaignId: z.string().min(1), saleId: z.string().min(1), revenueCents: z.number().int().positive() });

const MEASURE_AFTER_DAYS = 14;

/** Marketing: which campaigns bring in sales, and which don't. */
export const marketing: DepartmentModule = {
  id: "marketing",
  name: "Marketing",
  purpose: "Campaigns across email, social, ads and events, measured by the sales they bring in.",
  events: { "campaign.sent": CampaignSent, "campaign.sale_attributed": CampaignAttributed },
  normalizers: [],
  extractors: [
    extractor("marketing-signals", (event) => {
      if (event.type === "campaign.sent") {
        const p = CampaignSent.parse(event.payload);
        return [signalFrom(event, "campaign.sent", { kind: "campaign", id: p.campaignId }, { ...p })];
      }
      if (event.type === "campaign.sale_attributed") {
        const p = CampaignAttributed.parse(event.payload);
        return [signalFrom(event, "campaign.sale", { kind: "campaign", id: p.campaignId }, { ...p })];
      }
      return [];
    }),
  ],
  reasoners: [
    {
      name: "marketing.campaign-return",
      reason: ({ organizationId, signals, now }) => {
        const sales = new Map<string, Signal[]>();
        for (const s of signals.filter((s) => s.kind === "campaign.sale")) {
          sales.set(s.subject.id, [...(sales.get(s.subject.id) ?? []), s]);
        }
        return signals
          .filter((s) => s.kind === "campaign.sent" && daysBetween(s.observedAt, now) >= MEASURE_AFTER_DAYS)
          .flatMap((s) => {
            const c = value<z.infer<typeof CampaignSent>>(s);
            if (c.costCents === 0) return [];
            const attributed = sales.get(c.campaignId) ?? [];
            const revenue = attributed.reduce((sum, x) => sum + value<{ revenueCents: number }>(x).revenueCents, 0);
            const ratio = revenue / c.costCents;
            if (ratio >= 1 && ratio < 3) return [];
            const summary =
              ratio >= 3
                ? `"${c.name}" (${c.channel}) returned ${dollars(revenue)} on ${dollars(c.costCents)}, ${ratio.toFixed(1)}x. Run it again or scale it up.`
                : `"${c.name}" (${c.channel}) returned ${dollars(revenue)} on ${dollars(c.costCents)}. Rework or drop it before spending more.`;
            return [
              recommend({
                department: "marketing",
                key: `roi_${c.campaignId}`,
                organizationId,
                summary,
                confidence: Math.min(0.85, 0.5 + attributed.length * 0.05),
                expectedImpact: "Moves marketing spend to what sells",
                basedOn: [s, ...attributed],
                now,
              }),
            ];
          });
      },
    },
  ],
};
