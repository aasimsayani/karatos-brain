import { createHash } from "node:crypto";
import type { DeputyObject } from "./client.js";

/**
 * Turns Deputy's records into Brain A events, so labor hours and cost can
 * be set against sales and bench output by day and location.
 *
 * - A location (Company) becomes `labor.location_updated`, and an area
 *   within it (OperationalUnit) `labor.area_updated`.
 * - A team member becomes `labor.employee_updated`.
 * - A scheduled shift (Roster) becomes `labor.shift_updated`, a worked
 *   shift (Timesheet) `labor.timesheet_updated`, and a leave request
 *   `labor.leave_updated`.
 *
 * Each is keyed by its record and a digest of what was kept, so reading one
 * again unchanged is a duplicate and an approval or a new cost is a new
 * version. Only what labor costing uses is kept. A team member is kept as
 * their Deputy ID, with their location, start and end dates and whether
 * they are active, never their name, birthday, address, contact details or
 * pronouns. Comments on shifts, timesheets and leave, and shift warnings,
 * are not kept. Money is whole cents. A record without an ID or a time that
 * reads is dead-lettered listing what was wrong.
 */

export interface DeputyEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const DEPUTY_EVENTS = {
  Company: "labor.location_updated",
  OperationalUnit: "labor.area_updated",
  Employee: "labor.employee_updated",
  Roster: "labor.shift_updated",
  Timesheet: "labor.timesheet_updated",
  Leave: "labor.leave_updated",
} as const satisfies Record<DeputyObject, string>;

const KINDS = { Company: "location", OperationalUnit: "area", Employee: "employee", Roster: "shift", Timesheet: "timesheet", Leave: "leave" } as const satisfies Record<DeputyObject, string>;
// Date.parse turns down minute or second 60; hour 24 it reads as the next day, so it is ruled out here.
const TIME = /^(\d{4}-\d{2}-\d{2})(?:T((?:[01]\d|2[0-3]):\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?)?$/;
const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;
/** Unix seconds from 2000 to 2100. */
const MIN_UNIX = 946_684_800;
const MAX_UNIX = 4_102_444_800;
const CONFIRM = ["not_required", "required", "confirmed", "declined"] as const;
const LEAVE_STATUS = ["awaiting_approval", "approved", "declined", "cancelled", "date_approved", "pay_approved"] as const;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
// Anything but an object reads as a record without the fields asked for.
const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const text = (v: unknown, max = 100): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** A positive whole-number ID, or undefined. Deputy writes 0 for none. */
const idOf = (v: unknown): number | undefined => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);

export const deputyRef = (kind: string, id: number) => `deputy:${kind}:${id}`;
const refOf = (kind: string, v: unknown): string | null => {
  const id = idOf(v);
  return id === undefined ? null : deputyRef(kind, id);
};

/** A time or day as Deputy writes it, as a UTC ISO time, or undefined. One without a zone is read as UTC. */
export function deputyTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}${m[3] ?? ""}${m[4] ?? "Z"}`);
  // Date.parse rolls a day like 02-30 into the next month, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(Date.parse(`${m[1]}T00:00:00Z`)).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** The day a Deputy date is for, as written (its zone is the location's), or null. */
export function deputyDay(v: unknown): string | null {
  return deputyTime(v) === undefined ? null : (v as string).slice(0, 10);
}

/** A Unix time in seconds as a UTC ISO time, or null. */
export function deputyUnix(v: unknown): string | null {
  return Number.isSafeInteger(v) && (v as number) >= MIN_UNIX && (v as number) <= MAX_UNIX ? new Date((v as number) * 1000).toISOString() : null;
}

/** Dollars, as a number or a decimal string, in whole cents, or null. */
export function deputyCents(v: unknown): number | null {
  // A number that isn't finite writes as a word, which isn't a decimal.
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!DECIMAL.test(s)) return null;
  const n = Number(s);
  // Rounded on the size, then signed, so half a cent rounds away from zero either way.
  const cents = Math.round(Math.abs(n) * 100);
  return n < 0 ? -cents : cents;
}

/** Hours or days as a number at or above 0, or null. */
function amount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && DECIMAL.test(v.trim()) ? Number(v) : Number.NaN;
  // NaN fails both comparisons, and infinity the second.
  return n >= 0 && n < 1e6 ? Math.round(n * 1000) / 1000 : null;
}

function payloadOf(object: DeputyObject, r: Record<string, unknown>): Record<string, unknown> {
  switch (object) {
    case "Company":
      return { name: text(r.CompanyName), code: text(r.Code, 40), active: flag(r.Active), parentLocationId: refOf("location", r.ParentCompany), isWorkplace: flag(r.IsWorkplace) };
    case "OperationalUnit":
      return { name: text(r.OperationalUnitName), locationId: refOf("location", r.Company), parentAreaId: refOf("area", r.Parent), active: flag(r.Active), payrollCode: text(r.PayrollExportName, 40) };
    case "Employee":
      return { locationId: refOf("location", r.Company), active: flag(r.Active), startDate: deputyDay(r.StartDate), endDate: deputyDay(r.TerminationDate), accessLevel: idOf(r.Role) ?? null };
    case "Roster":
      return {
        employeeId: refOf("employee", r.Employee),
        areaId: refOf("area", r.OperationalUnit),
        date: deputyDay(r.Date),
        startsAt: deputyUnix(r.StartTime),
        endsAt: deputyUnix(r.EndTime),
        hours: amount(r.TotalTime),
        costCents: deputyCents(r.Cost),
        published: flag(r.Published),
        open: flag(r.Open),
        confirmation: Number.isInteger(r.ConfirmStatus) ? (CONFIRM[r.ConfirmStatus as number] ?? "unknown") : null,
        timesheetId: refOf("timesheet", r.MatchedByTimesheet),
      };
    case "Timesheet":
      return {
        employeeId: refOf("employee", r.Employee),
        areaId: refOf("area", r.OperationalUnit),
        shiftId: refOf("shift", r.Roster),
        date: deputyDay(r.Date),
        startedAt: deputyUnix(r.StartTime),
        endedAt: deputyUnix(r.EndTime),
        hours: amount(r.TotalTime),
        costCents: deputyCents(r.Cost),
        timeApproved: flag(r.TimeApproved),
        payApproved: flag(r.PayRuleApproved),
        inProgress: flag(r.IsInProgress ?? r.isInProgress),
        discarded: flag(r.Discarded),
        leaveId: refOf("leave", r.LeaveId),
        exported: flag(r.Exported),
        paid: flag(r.PayStaged),
        flagged: Number.isSafeInteger(r.ValidationFlag) ? (r.ValidationFlag as number) !== 0 : null,
      };
    case "Leave":
      return {
        employeeId: refOf("employee", r.Employee),
        locationId: refOf("location", r.Company),
        leaveRuleId: refOf("leave_rule", r.LeaveRule),
        startDate: deputyDay(r.DateStart),
        endDate: deputyDay(r.DateEnd),
        days: amount(r.Days),
        hours: amount(r.TotalHours),
        status: Number.isInteger(r.Status) ? (LEAVE_STATUS[r.Status as number] ?? "unknown") : null,
      };
  }
}

export interface DeputyContext {
  receivedAt: string;
}

/** The event for one Deputy record. One that doesn't read is dead-lettered with its problems. */
export function deputyEvent(object: DeputyObject, raw: unknown, ctx: DeputyContext): DeputyEvent {
  const r = record(raw);
  const kind = KINDS[object];
  const problems: string[] = [];
  const id = idOf(r.Id);
  if (id === undefined) problems.push(`${kind} has no ID that reads`);
  const at = deputyTime(r.Modified) ?? deputyTime(r.Created);
  if (!at) problems.push(`${kind} has no time that reads`);
  const ok = problems.length === 0;
  const payload: Record<string, unknown> = ok ? { system: "Deputy", [`${kind}Id`]: deputyRef(kind, id!), ...payloadOf(object, r), modifiedAt: at } : { system: "Deputy", [`${kind}Id`]: id === undefined ? null : deputyRef(kind, id), problems };
  const key = ok ? `deputy:${kind}:${id}:${short(payload)}` : `deputy:unreadable_${kind}:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: DEPUTY_EVENTS[object], occurredAt: ok ? at : undefined, receivedAt: ctx.receivedAt, idempotencyKey: key, payload };
}
