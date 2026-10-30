import { createHash } from "node:crypto";

/**
 * Turns Gusto payrolls into Brain A events: one for each processed payroll
 * with its totals, and one for each employee it paid. Employees are named
 * by Gusto's employee UUID only: no names, pay rates, bank details, tax
 * withholdings or deductions are kept, just what finance needs to see what
 * staff cost and what went to commissions and bonuses.
 *
 * Gusto sends money as decimal strings; they become whole cents here.
 * Gusto has no version number on a payroll, so each version is keyed by a
 * hash of what was kept, and a replay of the same payroll is a duplicate.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface GustoBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const PAYROLL_EVENT_TYPE = "payroll.payroll_processed";
export const EMPLOYEE_PAY_EVENT_TYPE = "payroll.employee_paid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(-?)(\d{1,12})(?:\.(\d+))?$/;

export const gustoRef = (name: string, id: string) => `gusto:${name}:${id.toLowerCase()}`;

/**
 * A decimal amount, as Gusto's string or a number, in whole cents. Strings
 * are read digit by digit, rounding half a cent away from zero, so no
 * floating-point error creeps in. Null for anything else.
 */
export function gustoCents(amount: unknown): number | null {
  if (typeof amount === "number") return Number.isFinite(amount) ? Math.round(amount * 100) : null;
  const m = typeof amount === "string" ? DECIMAL.exec(amount.trim()) : null;
  if (!m) return null;
  const fraction = (m[3] ?? "").padEnd(3, "0");
  const cents = Number(m[2]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  return m[1] && cents ? -cents : cents;
}

/** A calendar day Gusto wrote, as YYYY-MM-DD, or undefined if it isn't a real day. */
export function gustoDay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const day = value.trim().slice(0, 10);
  if (!DAY.test(day)) return undefined;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : undefined;
}

const text = (value: unknown, max = 80) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const uuid = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined);
const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object") : []);
const hash12 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const sumCents = (items: Record<string, unknown>[], pick: (item: Record<string, unknown>) => boolean, field = "amount") =>
  items.filter(pick).reduce((sum, item) => sum + (gustoCents(item[field]) ?? 0), 0);
const named = (pattern: RegExp) => (item: Record<string, unknown>) => pattern.test(String(item.name ?? ""));
const hours = (items: Record<string, unknown>[]) => Math.round(items.reduce((sum, item) => sum + (Number(item.hours) || 0), 0) * 1000) / 1000;

/** Drops fields with no value, so a payload says only what Gusto said. */
const defined = (payload: Record<string, unknown>) => Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): GustoBrainEvent {
  const version = hash12(payload);
  return { id: `gusto_${key}_${version}`, type, occurredAt, receivedAt, idempotencyKey: `gusto:${key}:${version}`, payload };
}

/** What kind of run a payroll was: regular, off-cycle (a bonus run, a correction) or external (recorded from another provider). */
function payrollKind(p: Record<string, unknown>): "regular" | "off_cycle" | "external" {
  if (p.external === true) return "external";
  return p.off_cycle === true ? "off_cycle" : "regular";
}

/**
 * Events for one payroll as Gusto's detail endpoint answers it. A payroll
 * that isn't processed gives nothing: until then its numbers can change.
 * One with no check date still gives its event, with no time, so the
 * pipeline dead-letters it rather than filing it under a made-up day.
 */
export function gustoPayrollEvents(payroll: unknown, receivedAt: string): GustoBrainEvent[] {
  if (!payroll || typeof payroll !== "object") return [];
  const p = payroll as Record<string, unknown>;
  const id = uuid(p.payroll_uuid) ?? uuid(p.uuid);
  if (!id || p.processed !== true) return [];
  const checkDate = gustoDay(p.check_date);
  const occurredAt = checkDate ? `${checkDate}T00:00:00.000Z` : undefined;
  const totals = (p.totals && typeof p.totals === "object" ? p.totals : {}) as Record<string, unknown>;
  const period = (p.pay_period && typeof p.pay_period === "object" ? p.pay_period : {}) as Record<string, unknown>;
  const payrollId = gustoRef("payroll", id);
  const paid = list(p.employee_compensations).filter((c) => c.excluded !== true && uuid(c.employee_uuid));
  const kind = payrollKind(p);

  const employees = paid.map((c) => {
    const employeeId = gustoRef("employee", uuid(c.employee_uuid)!);
    const fixed = list(c.fixed_compensations);
    const hourly = list(c.hourly_compensations);
    return event(
      `employee_pay:${id}:${uuid(c.employee_uuid)}`,
      EMPLOYEE_PAY_EVENT_TYPE,
      occurredAt,
      receivedAt,
      defined({
        payrollId,
        employeeId,
        checkDate,
        kind,
        grossPayCents: gustoCents(c.gross_pay),
        netPayCents: gustoCents(c.net_pay),
        hours: hours(hourly),
        overtimeCents: sumCents(hourly, named(/overtime/i)),
        commissionCents: sumCents(fixed, named(/commission/i)),
        bonusCents: sumCents(fixed, named(/bonus/i)),
        tipsCents: sumCents(fixed, named(/tips/i)),
        paymentMethod: text(c.payment_method, 30),
      }),
    );
  });

  const run = event(
    `payroll:${id}`,
    PAYROLL_EVENT_TYPE,
    occurredAt,
    receivedAt,
    defined({
      payrollId,
      checkDate,
      processedDate: gustoDay(p.processed_date),
      periodStart: gustoDay(period.start_date),
      periodEnd: gustoDay(period.end_date),
      payScheduleId: uuid(period.pay_schedule_uuid) && gustoRef("pay_schedule", uuid(period.pay_schedule_uuid)!),
      kind,
      offCycleReason: kind === "off_cycle" ? text(p.off_cycle_reason) : undefined,
      grossPayCents: gustoCents(totals.gross_pay),
      netPayCents: gustoCents(totals.net_pay),
      employerTaxesCents: gustoCents(totals.employer_taxes),
      employeeTaxesCents: gustoCents(totals.employee_taxes),
      benefitsCents: gustoCents(totals.benefits),
      reimbursementsCents: gustoCents(totals.reimbursements),
      bonusesCents: gustoCents(totals.employee_bonuses),
      commissionsCents: gustoCents(totals.employee_commissions),
      companyDebitCents: gustoCents(totals.company_debit),
      employeeCount: paid.length,
    }),
  );
  return [run, ...employees];
}
