import { z } from "zod";
import type { DepartmentModule } from "../department.js";
import { calendarDaysSince, daysBetween, dollars, extractor, latestBySubject, recommend, signalFrom, value } from "../department.js";

const BankTransactionImported = z.object({
  transactionId: z.string().min(1),
  accountId: z.string().min(1),
  amountCents: z.number().int(),
  description: z.string(),
  category: z.enum(["cash_deposit", "card_settlement", "vendor_payment", "payroll", "fee", "other"]).default("other"),
});

const Cents = z.number().int().nullable().optional();

/** An account and its balances, from a bank feed such as Plaid. A card's balance is what is owed. */
const BankAccountUpdated = z.object({
  accountId: z.string().min(1),
  name: z.string().optional(),
  accountKind: z.string().optional(),
  currentBalanceCents: Cents,
  availableBalanceCents: Cents,
  currency: z.string().optional(),
});

/** A sales invoice from the books (QuickBooks, Xero). balanceCents is what is still owed on it. */
const InvoiceUpdated = z.object({
  invoiceId: z.string().min(1),
  number: z.string().optional(),
  customerId: z.string().optional(),
  txnDate: z.string().optional(),
  dueDate: z.string().optional(),
  totalCents: Cents,
  balanceCents: Cents,
  currency: z.string().optional(),
  status: z.string().optional(),
});

/** A record deleted from the books. Only deleted invoices matter here. */
const RecordDeleted = z.object({ recordId: z.string().min(1), entity: z.string().min(1) });

/** A processed payroll and its totals, from payroll software such as Gusto. */
const PayrollProcessed = z.object({
  payrollId: z.string().min(1),
  checkDate: z.string().optional(),
  processedDate: z.string().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  payScheduleId: z.string().optional(),
  kind: z.enum(["regular", "off_cycle", "external"]),
  offCycleReason: z.string().optional(),
  grossPayCents: Cents,
  netPayCents: Cents,
  employerTaxesCents: Cents,
  employeeTaxesCents: Cents,
  benefitsCents: Cents,
  reimbursementsCents: Cents,
  bonusesCents: Cents,
  commissionsCents: Cents,
  companyDebitCents: Cents,
  employeeCount: z.number().int().nonnegative(),
});

/** What one employee was paid in one payroll. The employee is an id only. */
const EmployeePaid = z.object({
  payrollId: z.string().min(1),
  employeeId: z.string().min(1),
  checkDate: z.string().optional(),
  kind: z.enum(["regular", "off_cycle", "external"]),
  grossPayCents: Cents,
  netPayCents: Cents,
  hours: z.number().nonnegative(),
  overtimeCents: z.number().int(),
  commissionCents: z.number().int(),
  bonusCents: z.number().int(),
  tipsCents: z.number().int(),
  paymentMethod: z.string().optional(),
});

const WINDOW_DAYS = 30;
const DEPOSIT_LAG_DAYS = 3;
const TOLERANCE = 0.95;
const MIN_GAP_CENTS = 20_000;
const OVERDUE_DAYS = 30;
const MIN_OVERDUE_CENTS = 50_000;
/** A regular payroll this much above the average of the ones before it gets a second look. */
const PAYROLL_JUMP = 1.25;
const MIN_PAYROLL_JUMP_CENTS = 50_000;
const PAYROLL_HISTORY = 3;
/** Invoice statuses (Xero's, lowercased) that mean nothing more is owed. */
const CLOSED_STATUSES = new Set(["paid", "voided", "deleted", "draft"]);

/**
 * Finance: bank activity checked against what the store took in.
 * Chase CSV imports arrive here as bank transactions. Bank feeds add each
 * account's balances, and the books add sales invoices and what is still
 * owed on them, so the console can show cash position and receivables.
 * Payroll software adds each processed payroll and what each employee was
 * paid, and a regular payroll far above the ones before it is flagged.
 */
export const finance: DepartmentModule = {
  id: "finance",
  name: "Finance",
  purpose: "Bank and card activity reconciled against sales, cash position, and what customers still owe.",
  events: {
    "bank.transaction_imported": BankTransactionImported,
    "bank.account_updated": BankAccountUpdated,
    "accounting.invoice_updated": InvoiceUpdated,
    "accounting.record_deleted": RecordDeleted,
    "payroll.payroll_processed": PayrollProcessed,
    "payroll.employee_paid": EmployeePaid,
  },
  normalizers: [],
  extractors: [
    extractor("finance-signals", (event) => {
      if (event.type !== "bank.transaction_imported") return [];
      const p = BankTransactionImported.parse(event.payload);
      return [signalFrom(event, "bank.transaction", { kind: "bank_account", id: p.accountId }, { ...p })];
    }),
    extractor("finance-balances", (event) => {
      if (event.type !== "bank.account_updated") return [];
      const p = BankAccountUpdated.parse(event.payload);
      return [signalFrom(event, "bank.balance", { kind: "bank_account", id: p.accountId }, { ...p })];
    }),
    extractor("finance-receivables", (event) => {
      if (event.type === "accounting.invoice_updated") {
        const p = InvoiceUpdated.parse(event.payload);
        return [signalFrom(event, "receivable.invoice", { kind: "invoice", id: p.invoiceId }, { ...p })];
      }
      if (event.type === "accounting.record_deleted") {
        const p = RecordDeleted.parse(event.payload);
        return p.entity === "invoice" ? [signalFrom(event, "receivable.removed", { kind: "invoice", id: p.recordId }, { invoiceId: p.recordId })] : [];
      }
      return [];
    }),
    extractor("finance-payroll", (event) => {
      if (event.type === "payroll.payroll_processed") {
        const p = PayrollProcessed.parse(event.payload);
        return [signalFrom(event, "payroll.run", { kind: "payroll", id: p.payrollId }, { ...p })];
      }
      if (event.type === "payroll.employee_paid") {
        const p = EmployeePaid.parse(event.payload);
        return [signalFrom(event, "payroll.employee_pay", { kind: "employee_pay", id: `${p.payrollId}/${p.employeeId}` }, { ...p })];
      }
      return [];
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
      {
      name: "finance.overdue-receivables",
      reason: ({ organizationId, signals, now }) => {
        // The latest word on each invoice: still open and owed, or deleted from the books.
        const overdue = [...latestBySubject(signals, ["receivable.invoice", "receivable.removed"]).values()].filter((s) => {
          if (s.kind !== "receivable.invoice") return false;
          const v = value<{ balanceCents?: number | null; dueDate?: string; status?: string; currency?: string }>(s);
          return (
            (v.currency ?? "USD") === "USD" &&
            typeof v.balanceCents === "number" && v.balanceCents > 0 &&
            !CLOSED_STATUSES.has(v.status ?? "") &&
            // A due date that doesn't read gives NaN days, which is never overdue.
            typeof v.dueDate === "string" &&
            calendarDaysSince(v.dueDate, now) >= OVERDUE_DAYS
          );
        });
        const owed = overdue.reduce((sum, s) => sum + value<{ balanceCents: number }>(s).balanceCents, 0);
        if (owed < MIN_OVERDUE_CENTS) return [];
        return [
          recommend({
            department: "finance",
            key: "overdue_receivables",
            organizationId,
            summary: `${dollars(owed)} across ${overdue.length} ${overdue.length === 1 ? "invoice is" : "invoices are"} more than ${OVERDUE_DAYS} days past due. Follow up with those customers, oldest first.`,
            confidence: 0.8,
            expectedImpact: `Brings in up to ${dollars(owed)} owed`,
            basedOn: overdue,
            now,
          }),
        ];
      },
    },
    {
      name: "finance.payroll-jump",
      reason: ({ organizationId, signals, now }) => {
        type Run = { payrollId: string; checkDate?: string; payScheduleId?: string; kind: string; grossPayCents?: number | null };
        // The latest version of each regular payroll, by pay schedule, oldest check date first.
        const schedules = new Map<string, typeof signals>();
        for (const s of latestBySubject(signals, ["payroll.run"]).values()) {
          const run = value<Run>(s);
          if (run.kind !== "regular" || typeof run.grossPayCents !== "number" || typeof run.checkDate !== "string") continue;
          const key = run.payScheduleId ?? "";
          schedules.set(key, [...(schedules.get(key) ?? []), s]);
        }
        return [...schedules.values()].flatMap((runs) => {
          runs.sort((a, b) => value<Run>(a).checkDate!.localeCompare(value<Run>(b).checkDate!));
          const latest = runs.at(-1)!;
          const run = value<Run>(latest);
          const age = calendarDaysSince(run.checkDate!, now);
          const before = runs.slice(-1 - PAYROLL_HISTORY, -1);
          if (age > WINDOW_DAYS || before.length < PAYROLL_HISTORY) return [];
          const average = Math.round(before.reduce((sum, s) => sum + value<Run>(s).grossPayCents!, 0) / before.length);
          const gross = run.grossPayCents!;
          if (gross <= average * PAYROLL_JUMP || gross - average < MIN_PAYROLL_JUMP_CENTS) return [];
          const percent = Math.round(((gross - average) / average) * 100);
          return [
            recommend({
              department: "finance",
              key: `payroll_jump_${run.payrollId}`,
              organizationId,
              summary: `The payroll for ${run.checkDate} came to ${dollars(gross)} gross, ${percent}% more than the ${dollars(average)} average of the ${PAYROLL_HISTORY} before it. Check its hours, overtime, commissions and bonuses before the next payroll runs.`,
              confidence: 0.6,
              expectedImpact: `Catches up to ${dollars(gross - average)} of payroll errors`,
              basedOn: [...before, latest],
              now,
            }),
          ];
        });
      },
    },
  ],
};
