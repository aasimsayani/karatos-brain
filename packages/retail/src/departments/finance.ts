import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { daysBetween, dollars, extractor, recommend, signalFrom, value } from "../department.js";

const BankTransactionImported = z.object({
  transactionId: z.string().min(1),
  accountId: z.string().min(1),
  amountCents: z.number().int(),
  description: z.string(),
  category: z.enum(["cash_deposit", "card_settlement", "vendor_payment", "payroll", "fee", "other"]).default("other"),
});

const WINDOW_DAYS = 30;
const DEPOSIT_LAG_DAYS = 3;
const TOLERANCE = 0.95;
const MIN_GAP_CENTS = 20_000;

/**
 * Finance: bank activity checked against what the store took in.
 * Chase CSV imports arrive here as bank transactions.
 */
export const finance: DepartmentModule = {
  id: "finance",
  name: "Finance",
  purpose: "Bank and card activity reconciled against sales, starting with cash handling.",
  events: { "bank.transaction_imported": BankTransactionImported },
  normalizers: [],
  extractors: [
    extractor("finance-signals", (event) => {
      if (event.type !== "bank.transaction_imported") return [];
      const p = BankTransactionImported.parse(event.payload);
      return [signalFrom(event, "bank.transaction", { kind: "bank_account", id: p.accountId }, { ...p })];
    }),
  ],
  reasoners: [
    {
      name: "finance.cash-deposits",
      reason: ({ organizationId, signals, now }) => {
        // Cash taken in long enough ago that it should have been deposited.
        const taken = signals.filter((s) => {
          const age = daysBetween(s.observedAt, now);
          return s.kind === "payment.cash_received" && age >= DEPOSIT_LAG_DAYS && age <= WINDOW_DAYS;
        });
        const deposits = signals.filter(
          (s) =>
            s.kind === "bank.transaction" &&
            value<{ category: string }>(s).category === "cash_deposit" &&
            daysBetween(s.observedAt, now) <= WINDOW_DAYS,
        );
        const received = taken.reduce((sum, s) => sum + value<{ amountCents: number }>(s).amountCents, 0);
        const deposited = deposits.reduce((sum, s) => sum + value<{ amountCents: number }>(s).amountCents, 0);
        if (received === 0 || deposited >= received * TOLERANCE || received - deposited < MIN_GAP_CENTS) return [];
        return [
          recommend({
            department: "finance",
            key: "cash_gap",
            organizationId,
            summary: `${dollars(received)} in cash sales over the last ${WINDOW_DAYS} days but only ${dollars(deposited)} in cash deposits. Reconcile the drawer logs and deposits.`,
            confidence: 0.7,
            expectedImpact: `Accounts for ${dollars(received - deposited)} of cash`,
            basedOn: [...taken, ...deposits],
            now,
          }),
        ];
      },
    },
  ],
};
