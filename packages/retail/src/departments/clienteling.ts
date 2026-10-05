import type { Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, entityFrom, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

const ProfileUpdated = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1),
  marketingConsent: z.boolean(),
  preferences: z
    .object({
      metals: z.array(z.string()).optional(),
      styles: z.array(z.string()).optional(),
      ringSize: z.string().optional(),
    })
    .optional(),
});

const OccasionRecorded = z.object({
  customerId: z.string().min(1),
  occasion: z.enum(["birthday", "anniversary", "engagement", "graduation", "other"]),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  forPerson: z.string().optional(),
});

const WishlistItemAdded = z.object({ customerId: z.string().min(1), sku: z.string().min(1), note: z.string().optional() });

const OCCASION_LEAD_DAYS = 21;
const VIP_LIFETIME_CENTS = 500_000;
const LAPSED_AFTER_DAYS = 365;

/** Days from now until the next time month/day comes around. */
export function daysUntilNext(month: number, day: number, now: string): number {
  const today = new Date(now);
  const thisYear = Date.UTC(today.getUTCFullYear(), month - 1, day);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const next = thisYear >= start ? thisYear : Date.UTC(today.getUTCFullYear() + 1, month - 1, day);
  return Math.round((next - start) / 86_400_000);
}

function consentByCustomer(signals: Signal[]): Map<string, { consent: boolean; name: string; signal: Signal }> {
  const result = new Map<string, { consent: boolean; name: string; signal: Signal }>();
  for (const s of latestBySubject(signals, ["customer.profile"]).values()) {
    const v = value<{ marketingConsent: boolean; name: string }>(s);
    result.set(s.subject.id, { consent: v.marketingConsent, name: v.name, signal: s });
  }
  return result;
}

/**
 * Clienteling: knowing each customer, their occasions and wishes, and
 * reaching out at the right moment. Reads sales signals for lifetime value.
 */
export const clienteling: DepartmentModule = {
  id: "clienteling",
  name: "Clienteling and CRM",
  purpose: "Each customer's story: occasions, wish lists, preferences and when to reach out.",
  events: {
    "customer.profile_updated": ProfileUpdated,
    "customer.occasion_recorded": OccasionRecorded,
    "wishlist.item_added": WishlistItemAdded,
  },
  normalizers: [
    entityFrom<z.infer<typeof ProfileUpdated>>("clienteling-customers", "customer.profile_updated", (p) => ({
      ref: { kind: "customer", id: p.customerId },
      attributes: { name: p.name, marketingConsent: p.marketingConsent, preferences: p.preferences ?? {} },
    })),
  ],
  extractors: [
    extractor("clienteling-signals", (event) => {
      const subject = (id: string) => ({ kind: "customer", id });
      switch (event.type) {
        case "customer.profile_updated": {
          const p = ProfileUpdated.parse(event.payload);
          return [signalFrom(event, "customer.profile", subject(p.customerId), { name: p.name, marketingConsent: p.marketingConsent })];
        }
        case "customer.occasion_recorded": {
          const p = OccasionRecorded.parse(event.payload);
          return [signalFrom(event, "customer.occasion", subject(p.customerId), { ...p })];
        }
        case "wishlist.item_added": {
          const p = WishlistItemAdded.parse(event.payload);
          return [signalFrom(event, "customer.wishlist", subject(p.customerId), { ...p })];
        }
        default:
          return [];
      }
    }),
  ],
  reasoners: [
    {
      name: "clienteling.upcoming-occasions",
      reason: ({ organizationId, signals, now }) => {
        const consent = consentByCustomer(signals);
        const wishlists = signals.filter((s) => s.kind === "customer.wishlist");
        return signals
          .filter((s) => s.kind === "customer.occasion")
          .flatMap((s) => {
            const o = value<z.infer<typeof OccasionRecorded>>(s);
            const profile = consent.get(o.customerId);
            if (!profile?.consent) return [];
            const days = daysUntilNext(o.month, o.day, now);
            if (days > OCCASION_LEAD_DAYS) return [];
            const wishes = wishlists.filter((w) => w.subject.id === o.customerId);
            const skus = wishes.map((w) => value<{ sku: string }>(w).sku);
            const who = o.forPerson ? ` (${o.forPerson})` : "";
            return [
              recommend({
                department: "clienteling",
                key: `occasion_${o.customerId}_${o.occasion}`,
                organizationId,
                summary: `${profile.name}'s ${o.occasion}${who} is in ${days} days. Reach out${skus.length ? `; their wish list has ${skus.join(", ")}` : ""}.`,
                confidence: skus.length ? 0.8 : 0.6,
                expectedImpact: "Occasion-driven sale",
                basedOn: [s, profile.signal, ...wishes],
                now,
              }),
            ];
          });
      },
    },
    {
      name: "clienteling.lapsed-vip",
      reason: ({ organizationId, signals, now }) => {
        const consent = consentByCustomer(signals);
        const purchases = new Map<string, Signal[]>();
        for (const s of signals) {
          if (s.kind !== "sale.customer_purchase") continue;
          purchases.set(s.subject.id, [...(purchases.get(s.subject.id) ?? []), s]);
        }
        return [...purchases.entries()].flatMap(([customerId, list]) => {
          const profile = consent.get(customerId);
          if (!profile?.consent) return [];
          const lifetime = list.reduce((sum, s) => sum + value<{ totalCents: number }>(s).totalCents, 0);
          const last = list.map((s) => s.observedAt).sort().at(-1)!;
          const idle = daysBetween(last, now);
          if (lifetime < VIP_LIFETIME_CENTS || idle < LAPSED_AFTER_DAYS) return [];
          return [
            recommend({
              department: "clienteling",
              key: `lapsed_${customerId}`,
              organizationId,
              summary: `${profile.name} has spent ${dollars(lifetime)} with you but hasn't bought in ${idle} days. Invite them in personally.`,
              confidence: 0.65,
              expectedImpact: "Win back a high-value customer",
              basedOn: [...list, profile.signal],
              now,
            }),
          ];
        });
      },
    },
  ],
};
