import type { Signal } from "@karatos/core";
import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, extractor, recommend, signalFrom, value } from "../department.js";

const FORM_8300_THRESHOLD_CENTS = 1_000_000;
const RELATED_WINDOW_MS = 24 * 3_600_000;
const REVIEW_WINDOW_DAYS = 30;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One row of the store's Form 8300 filings log, as the Form 8300 connector writes it. */
const Form8300Filing = z.object({
  filingId: z.string().min(1),
  filedOn: day,
  cashReceivedOn: day,
  saleIds: z.array(z.string().min(1)).min(1),
  cashCents: z.number().int().positive(),
  status: z.enum(["submitted", "accepted", "accepted_with_warnings", "rejected"]),
  bsaId: z.string().optional(),
  trackingId: z.string().optional(),
  customerId: z.string().optional(),
  statementSentOn: day.optional(),
  /** Filed voluntarily for a suspicious transaction (box 1b): no statement goes to the customer. */
  suspicious: z.boolean().optional(),
});

type Filing = z.infer<typeof Form8300Filing>;

/** Where a filing stands across every version of its log row: rejected is final, and a statement once sent stays sent. */
const STATUS_RANK: Record<Filing["status"], number> = { submitted: 0, accepted: 1, accepted_with_warnings: 1, rejected: 2 };

function filings(signals: Signal[]): Filing[] {
  const byId = new Map<string, Filing>();
  for (const s of signals) {
    if (s.kind !== "compliance.form_8300_filing") continue;
    const f = value<Filing>(s);
    const seen = byId.get(f.filingId);
    if (!seen) {
      byId.set(f.filingId, f);
      continue;
    }
    const later = STATUS_RANK[f.status] > STATUS_RANK[seen.status] ? f : seen;
    const statementSentOn = seen.statementSentOn ?? f.statementSentOn;
    byId.set(f.filingId, { ...later, ...(statementSentOn ? { statementSentOn } : {}) });
  }
  return [...byId.values()];
}

/**
 * True when a sale id from the log names this POS sale. The log has what
 * staff see on the receipt ("S-4015"); the POS signal carries the
 * connector's full id ("pos:generic:sale:S-4015").
 */
const sameSale = (posSaleId: string, logged: string) => posSaleId === logged || posSaleId.endsWith(`:${logged}`);

const filingName = (f: Filing) => (f.bsaId ? `BSA ID ${f.bsaId}` : f.trackingId ? `BSA Tracking ID ${f.trackingId}` : `filed ${f.filedOn}`);

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
 *
 * The store's Form 8300 filings log, when connected, closes a reminder once
 * a filing covers the sale, raises it again if FinCEN rejects the filing,
 * and adds the written statement each person named on a required filing
 * must get by January 31 of the next year (never for one filed voluntarily
 * as suspicious, which the customer must not hear about).
 */
export const compliance: DepartmentModule = {
  id: "compliance",
  name: "Compliance",
  purpose: "Cash reporting, anti-money-laundering checks and secondhand-dealer rules, raised as reminders.",
  events: { "compliance.form_8300_filing_recorded": Form8300Filing },
  normalizers: [],
  extractors: [
    extractor("form-8300-filings", (event) => {
      if (event.type !== "compliance.form_8300_filing_recorded") return [];
      const p = Form8300Filing.parse(event.payload);
      return [signalFrom(event, "compliance.form_8300_filing", { kind: "form_8300", id: p.filingId }, { ...p })];
    }),
  ],
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
        const filed = filings(signals);
        const fileSignals = signals.filter((s) => s.kind === "compliance.form_8300_filing");
        return groups.flatMap((group) => {
          const total = group.reduce((sum, s) => sum + value<CashPayment>(s).amountCents, 0);
          if (total <= FORM_8300_THRESHOLD_CENTS) return [];
          const first = group[0]!;
          const deadline = 15 - daysBetween(first.observedAt, now);
          const saleIds = [...new Set(group.map((s) => value<CashPayment>(s).saleId))];
          const sales = saleIds.join(", ");
          const covering = filed.filter((f) => saleIds.some((sale) => f.saleIds.some((logged) => sameSale(sale, logged))));
          if (covering.some((f) => f.status !== "rejected")) return [];
          const rejected = covering.at(-1);
          const due = deadline >= 0 ? `within ${deadline} days` : `now (${-deadline} days overdue)`;
          return [
            recommend({
              department: "compliance",
              key: `8300_${first.id}`,
              organizationId,
              summary: rejected
                ? `FinCEN rejected the Form 8300 for sale ${sales} (${filingName(rejected)}). Correct it and file again ${due}, then add the new filing to the log.`
                : `${dollars(total)} in cash was received for sale ${sales}. File IRS Form 8300 ${due} and keep a copy for 5 years.`,
              confidence: 0.95,
              expectedImpact: "Avoids IRS penalties for late or missing Form 8300",
              basedOn: rejected ? [...group, ...fileSignals.filter((f) => value<Filing>(f).filingId === rejected.filingId)] : group,
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
      name: "compliance.form-8300-statement",
      reason: ({ organizationId, signals, now }) => {
        const today = now.slice(0, 10);
        return filings(signals).flatMap((f) => {
          // Only a required filing gets a statement: one filed voluntarily as suspicious, or for $10,000 or less, must not be mentioned to the customer.
          if (f.status === "rejected" || f.statementSentOn || f.suspicious || f.cashCents <= FORM_8300_THRESHOLD_CENTS) return [];
          // The statement covers the calendar year the cash came in: remind from December 1 through the end of the next year.
          const year = Number(f.cashReceivedOn.slice(0, 4));
          const dueOn = `${year + 1}-01-31`;
          if (today < `${year}-12-01` || today > `${year + 1}-12-31`) return [];
          const late = today > dueOn;
          const customer = f.customerId ? `customer ${f.customerId}` : "each person named on it";
          return [
            recommend({
              department: "compliance",
              key: `8300_statement_${f.filingId}`,
              organizationId,
              summary: `Send ${customer} the written Form 8300 statement for sale ${f.saleIds.join(", ")} (${dollars(f.cashCents)} in cash, ${filingName(f)}). It ${late ? `was due January 31, ${year + 1}; send it now` : `is due by January 31, ${year + 1}`} and must give the store's contact name, phone number and address, the total cash reported, and that it was reported to the IRS. Note the date sent in the log.`,
              confidence: 0.9,
              expectedImpact: "Avoids the IRS penalty for not giving the customer statement",
              basedOn: signals.filter((s) => s.kind === "compliance.form_8300_filing" && value<Filing>(s).filingId === f.filingId),
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
