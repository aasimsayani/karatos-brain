import type { Signal } from "@karatos/core";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, recommend, value } from "../department.js";

const FORM_8300_THRESHOLD_CENTS = 1_000_000;
const RELATED_WINDOW_MS = 24 * 3_600_000;
const REVIEW_WINDOW_DAYS = 30;

type CashPayment = {
  saleId: string;
  customerId: string | null;
  amountCents: number;
};

/** Largest cash total received within any 24-hour window. */
function largestDayTotal(payments: Signal[]): number {
  const sorted = [...payments].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  let best = 0;
  for (const start of sorted) {
    const from = Date.parse(start.observedAt);
    const total = sorted
      .filter((s) => Date.parse(s.observedAt) >= from && Date.parse(s.observedAt) - from <= RELATED_WINDOW_MS)
      .reduce((sum, s) => sum + value<CashPayment>(s).amountCents, 0);
    best = Math.max(best, total);
  }
  return best;
}

/**
 * Compliance for jewelry retailers. It reads other departments' signals and
 * raises reminders. These are prompts for the owner, not legal advice.
 *
 * - IRS Form 8300: cash over $10,000 in one transaction, or related
 *   transactions, must be reported within 15 days.
 * - Dealers in precious metals and stones must run an AML program, including
 *   watching for payments split to stay under reporting thresholds.
 * - Most states require ID and records when buying jewelry from the public.
 */
export const compliance: DepartmentModule = {
  id: "compliance",
  name: "Compliance",
  purpose: "Cash reporting, anti-money-laundering checks and secondhand-dealer rules, raised as reminders.",
  events: {},
  normalizers: [],
  extractors: [],
  reasoners: [
    {
      name: "compliance.form-8300",
      reason: ({ organizationId, signals, now }) => {
        const cash = signals.filter((s) => s.kind === "payment.cash_received");
        const groups: Signal[][] = [];
        // Same customer within 24 hours counts as related; anonymous sales stand alone.
        for (const s of [...cash].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
          const customer = value<CashPayment>(s).customerId;
          const group = groups.find(
            (g) =>
              customer !== null &&
              value<CashPayment>(g[0]!).customerId === customer &&
              Date.parse(s.observedAt) - Date.parse(g[0]!.observedAt) <= RELATED_WINDOW_MS,
          );
          if (group) group.push(s);
          else groups.push([s]);
        }
        return groups.flatMap((group) => {
          const total = group.reduce((sum, s) => sum + value<CashPayment>(s).amountCents, 0);
          if (total <= FORM_8300_THRESHOLD_CENTS) return [];
          const first = group[0]!;
          const deadline = 15 - daysBetween(first.observedAt, now);
          const sales = [...new Set(group.map((s) => value<CashPayment>(s).saleId))].join(", ");
          return [
            recommend({
              department: "compliance",
              key: `8300_${first.id}`,
              organizationId,
              summary: `${dollars(total)} in cash was received for sale ${sales}. File IRS Form 8300 ${deadline >= 0 ? `within ${deadline} days` : `now (${-deadline} days overdue)`} and keep a copy for 5 years.`,
              confidence: 0.95,
              expectedImpact: "Avoids IRS penalties for late or missing Form 8300",
              basedOn: group,
              now,
            }),
          ];
        });
      },
    },
    {
      name: "compliance.structuring-watch",
      reason: ({ organizationId, signals, now }) => {
        const byCustomer = new Map<string, Signal[]>();
        for (const s of signals) {
          if (s.kind !== "payment.cash_received") continue;
          const v = value<CashPayment>(s);
          if (!v.customerId || daysBetween(s.observedAt, now) > REVIEW_WINDOW_DAYS) continue;
          byCustomer.set(v.customerId, [...(byCustomer.get(v.customerId) ?? []), s]);
        }
        return [...byCustomer.entries()].flatMap(([customerId, list]) => {
          const amounts = list.map((s) => value<CashPayment>(s).amountCents);
          const total = amounts.reduce((a, b) => a + b, 0);
          const allUnder = amounts.every((a) => a <= FORM_8300_THRESHOLD_CENTS);
          if (list.length < 2 || !allUnder || total <= FORM_8300_THRESHOLD_CENTS) return [];
          // Already over the line within 24 hours: the Form 8300 reminder covers it.
          if (largestDayTotal(list) > FORM_8300_THRESHOLD_CENTS) return [];
          return [
            recommend({
              department: "compliance",
              key: `structuring_${customerId}`,
              organizationId,
              summary: `Customer ${customerId} paid ${dollars(total)} in cash across ${list.length} payments in ${REVIEW_WINDOW_DAYS} days, each under $10,000. Review under your AML program, and decide whether these are related for Form 8300.`,
              confidence: 0.6,
              expectedImpact: "Meets AML program duties for dealers in precious metals",
              basedOn: list,
              now,
            }),
          ];
        });
      },
    },
    {
      name: "compliance.seller-id",
      reason: ({ organizationId, signals, now }) =>
        signals
          .filter((s) => s.kind === "gold_purchase" && value<{ sellerIdVerified: boolean }>(s).sellerIdVerified === false)
          .map((s) => {
            const p = value<{ purchaseId: string; sellerId: string }>(s);
            return recommend({
              department: "compliance",
              key: `seller_id_${p.purchaseId}`,
              organizationId,
              summary: `Purchase ${p.purchaseId} from seller ${p.sellerId} has no verified ID. Record government ID before reselling or melting, and follow your state's hold period for secondhand goods.`,
              confidence: 0.9,
              expectedImpact: "Meets secondhand-dealer record rules and deters stolen goods",
              basedOn: [s],
              now,
            });
          }),
    },
  ],
};
