import { createHash } from "node:crypto";
import { CALENDLY_EVENT_TYPES, appointmentKind, safeTitle } from "../calendly/normalize.js";
import { formCustomerRefs } from "../custom_forms/customer.js";
import { ACUITY_MAX } from "./client.js";

/**
 * Turns an Acuity Scheduling appointment into one Brain A event, in the
 * types and shape the Calendly connector gives, so an appointment reads
 * alike whichever system booked it: appointment.booked, appointment.canceled
 * or appointment.no_show. It is keyed by the appointment's id and a digest
 * of what is kept, so one read again unchanged is a duplicate and one that
 * changed (moved, paid, cancelled, marked a no-show) is a new event.
 *
 * Appointments are personal, so the event keeps the shape of the
 * appointment and drops the person, as Calendly's does:
 *
 * - the client's email address and phone number only make keyed customer
 *   references, the same ones custom forms, Calendly and Klaviyo make.
 *   Neither is kept, and nor are names, notes, intake form answers (they
 *   aren't even asked for), labels, the location, certificate codes or the
 *   confirmation link;
 * - the appointment type's name is kept only when it doesn't carry the
 *   client's name or email, the check Calendly makes of an event's title;
 * - the calendar is kept by its Acuity id and name: it is the staff member
 *   or room the appointment is with, not the client.
 *
 * Acuity writes money as a decimal string, "10.00", kept as whole cents,
 * and the duration in minutes as a string, "60". An appointment without an
 * id, a start time or a duration that reads is dead-lettered listing what
 * was wrong, never guessed.
 */

export interface AcuityEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type AcuityRead = { ok: boolean; event: AcuityEvent };

/** The type of the marker dead-lettered for a day that filled a whole request. */
export const ACUITY_FULL_DAY_TYPE = "appointment.day_full";

const SYSTEM = "Acuity Scheduling";
const TITLE_MAX = 80;
const NAME_MAX = 80;
const ID = /^[1-9][0-9]{0,15}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})$/;
const AMOUNT = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/;
const DURATION = /^[1-9][0-9]{0,4}$/;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const realDay = (y: number, m: number, d: number) => {
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
};

/** An id Acuity gave: a positive whole number, or one written as digits. */
export function acuityId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

/** Acuity's `datetime`, such as 2013-07-02T10:15:00-0700, as an ISO time, or undefined. */
export function acuityTime(value: unknown): string | undefined {
  const m = typeof value === "string" ? TIME.exec(value) : null;
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, zone] = m as unknown as [string, string, string, string, string, string, string, string];
  if (!realDay(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined;
  const offset = zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59)) return undefined;
  return new Date(Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`)).toISOString();
}

/** A decimal amount in major units, "10.00", as whole cents, or undefined. */
export function acuityCents(value: unknown): number | undefined {
  if (typeof value !== "string" || !AMOUNT.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".") as [string, string?];
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** A duration in whole minutes, written "60" or 60, or undefined. */
export function acuityMinutes(value: unknown): number | undefined {
  const s = typeof value === "number" ? String(value) : value;
  return typeof s === "string" && DURATION.test(s) ? Number(s) : undefined;
}

/** Acuity's `dateCreated`, such as "June 17, 2013", as 2013-06-17, or undefined. */
export function acuityDay(value: unknown): string | undefined {
  const m = typeof value === "string" ? /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value.trim()) : null;
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month === 0 || !realDay(year, month, day)) return undefined;
  return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Names by id from a list of calendars or appointment types. Rows without an id or a name are left out. */
export function acuityNames(rows: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const r = obj(row);
    const id = acuityId(r?.id);
    const name = text(r?.name, NAME_MAX * 2);
    if (id && name) names.set(id, name);
  }
  return names;
}

export interface AcuityLookups {
  /** Appointment type names by id. */
  types: ReadonlyMap<string, string>;
  /** Calendar names by id. */
  calendars: ReadonlyMap<string, string>;
}

function read(type: string, problems: string[], key: string, raw: unknown, payload: Record<string, unknown>, occurredAt: string | undefined, receivedAt: string, failed: Record<string, unknown>): AcuityRead {
  const ok = problems.length === 0;
  const idempotencyKey = ok ? key : `acuity:unreadable_appointment:${short(raw)}`;
  return {
    ok,
    event: {
      id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? occurredAt : undefined,
      receivedAt,
      idempotencyKey,
      payload: ok ? payload : { system: SYSTEM, ...failed, problems },
    },
  };
}

/** Reads one appointment, from the canceled list or the scheduled one, into an appointment event, dead-lettered when anything needed doesn't read. */
export function acuityAppointmentEvent(raw: unknown, canceled: boolean, lookups: AcuityLookups, customerKey: string, receivedAt: string): AcuityRead {
  const problems: string[] = [];
  const a = obj(raw);
  if (!a) problems.push("appointment is not an object");
  const r = a ?? {};
  const appointmentId = acuityId(r.id);
  if (!appointmentId) problems.push("appointment has no id that reads");
  const startAt = acuityTime(r.datetime);
  if (!startAt) problems.push("appointment has no start time that reads");
  const durationMinutes = acuityMinutes(r.duration);
  if (durationMinutes === undefined) problems.push("appointment has no duration that reads");
  const endAt = startAt && durationMinutes !== undefined ? new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString() : undefined;

  const typeId = acuityId(r.appointmentTypeID);
  const calendarId = acuityId(r.calendarID);
  const typeName = (typeId && lookups.types.get(typeId)) || text(r.type, TITLE_MAX * 2);
  const calendarName = (calendarId && lookups.calendars.get(calendarId)) || text(r.calendar, NAME_MAX * 2);
  const status = r.noShow === true ? "no_show" : canceled ? "canceled" : "booked";
  const type = status === "no_show" ? CALENDLY_EVENT_TYPES.noShow : status === "canceled" ? CALENDLY_EVENT_TYPES.canceled : CALENDLY_EVENT_TYPES.booked;

  const payload = defined({
    system: SYSTEM,
    appointmentId,
    appointmentTypeId: typeId,
    title: safeTitle(typeName, { first_name: r.firstName, last_name: r.lastName, email: r.email }),
    kind: appointmentKind(typeName),
    status,
    canceled,
    startAt,
    endAt,
    durationMinutes,
    hostRefs: calendarId ? [`acuity:calendar:${calendarId}`] : [],
    calendarName: calendarName?.slice(0, NAME_MAX),
    customerRefs: formCustomerRefs(customerKey, { email: r.email, phone: r.phone }),
    bookedOn: acuityDay(r.dateCreated),
    priceCents: acuityCents(r.price),
    amountPaidCents: acuityCents(r.amountPaid),
    paid: r.paid === "yes" ? true : r.paid === "no" ? false : undefined,
  });
  // An appointment is when it starts: Acuity gives only the day it was booked, and no time it was cancelled.
  return read(type, problems, `acuity:appointment:${appointmentId}:${short(payload)}`, raw, payload, startAt, receivedAt, { appointmentId: appointmentId ?? null });
}

/**
 * The marker dead-lettered when a single day filled a whole request, so the
 * appointments past the first ACUITY_MAX that day are known to be missing
 * rather than silently left out.
 */
export function acuityFullDayEvent(day: string, canceled: boolean, receivedAt: string): AcuityEvent {
  const list = canceled ? "canceled" : "scheduled";
  const idempotencyKey = `acuity:full_day:${day}:${list}`;
  return {
    id: idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, "_"),
    type: ACUITY_FULL_DAY_TYPE,
    occurredAt: undefined,
    receivedAt,
    idempotencyKey,
    payload: { system: SYSTEM, day, canceled, read: ACUITY_MAX, problems: [`Acuity returned ${ACUITY_MAX} ${list} appointments for ${day}, the most one request asks for, so any more that day were not read`] },
  };
}
