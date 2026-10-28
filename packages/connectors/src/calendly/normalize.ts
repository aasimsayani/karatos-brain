import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";
import { CALENDLY_UUID } from "./client.js";

/**
 * Turns a Calendly scheduled event and one of its invitees into one Brain A
 * event: an appointment booked, cancelled, or marked a no-show. It is keyed
 * by the invitee and what was read, so a booking read again is a duplicate
 * and one that changes (moved, cancelled, marked a no-show) is a new event.
 *
 * Appointments are personal, so the event keeps the shape of the
 * appointment and drops the person:
 *
 * - the invitee's email address and text reminder number only make keyed
 *   customer references, the same ones custom forms and Klaviyo make, so a
 *   booking links to the person's form submissions and marketing profile.
 *   Neither is kept, and nor are names, guests' addresses, answers to the
 *   booking questions (only how many were answered), meeting notes, the
 *   cancellation reason, cancel and reschedule links, or where the meeting
 *   is (only what kind of place);
 * - the event's title is kept only when it doesn't carry the invitee's name
 *   or email, since a one-off meeting is often named after the person;
 * - hosts are kept by Calendly user id, which is staff, not the customer.
 *
 * An invitee without an id that reads, or an event without start and end
 * times that read, is dead-lettered listing what was wrong.
 */

export interface CalendlyEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const CALENDLY_EVENT_TYPES = {
  booked: "appointment.booked",
  canceled: "appointment.canceled",
  noShow: "appointment.no_show",
} as const;

/** What kind of appointment it is, read from its title, for the departments that care. */
export type AppointmentKind = "bridal" | "custom_design" | "repair" | "appraisal" | "pickup" | "consultation" | "other";
const KIND_RULES: [RegExp, AppointmentKind][] = [
  [/\b(bridal|engagement|wedding|proposal)\b/i, "bridal"],
  [/\b(custom|design|bespoke|cad)\b/i, "custom_design"],
  [/\b(repair|resiz\w*|sizing|clean\w*|inspection|drop[- ]?off|watch service)\b/i, "repair"],
  [/\b(apprais\w*|valuation|evaluation)\b/i, "appraisal"],
  [/\b(pick[- ]?up|collection)\b/i, "pickup"],
  [/\b(consult\w*|appointment|meeting|visit|call)\b/i, "consultation"],
];

export type LocationKind = "in_person" | "phone" | "video" | "custom" | "ask_invitee" | "unknown";
const LOCATION_KINDS: Record<string, LocationKind> = {
  physical: "in_person",
  outbound_call: "phone",
  inbound_call: "phone",
  google_conference: "video",
  zoom: "video",
  zoom_conference: "video",
  gotomeeting: "video",
  gotomeeting_conference: "video",
  microsoft_teams_conference: "video",
  webex_conference: "video",
  custom: "custom",
  ask_invitee: "ask_invitee",
};

const TITLE_MAX = 80;
const UTM_MAX = 80;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined);

/** The id at the end of a Calendly resource URI, or undefined when it isn't one. */
export function calendlyId(uri: unknown): string | undefined {
  if (typeof uri !== "string" || uri.length > 300) return undefined;
  const m = /^https:\/\/api\.calendly\.com\/[a-z_]+(?:\/[A-Za-z0-9-]{1,64}\/[a-z_]+)?\/([A-Za-z0-9-]{1,64})$/.exec(uri);
  return m && CALENDLY_UUID.test(m[1]!) ? m[1] : undefined;
}

/** A Calendly time as ISO, or null when it isn't a real UTC time. */
export function calendlyTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value)) return null;
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function appointmentKind(title: string | undefined): AppointmentKind {
  if (!title) return "other";
  const t = title.slice(0, TITLE_MAX * 2);
  return KIND_RULES.find(([re]) => re.test(t))?.[1] ?? "other";
}

/** The title, unless it carries the invitee's name or email. */
function safeTitle(title: string | undefined, invitee: Record<string, unknown>): string | undefined {
  if (!title) return undefined;
  const lower = title.toLowerCase();
  const email = typeof invitee.email === "string" ? invitee.email.toLowerCase() : "";
  const words = [invitee.name, invitee.first_name, invitee.last_name, email.split("@")[0], email]
    .flatMap((v) => (typeof v === "string" ? v.toLowerCase().split(/[\s,.]+/) : []))
    .filter((w) => w.length >= 2);
  // Longer words are matched anywhere, so "customer1" is caught in "customer1@...". Short names such as Al or Li are matched as whole words.
  const titleWords = new Set(lower.split(/[^\p{L}\p{N}]+/u));
  const named = words.some((w) => (w.length >= 3 ? lower.includes(w) : titleWords.has(w)));
  return named ? undefined : title.slice(0, TITLE_MAX);
}

/** Whole cents from Calendly's payment amount in currency units. Null when it isn't a number. */
function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(Number((value * 100).toPrecision(12))) : null;
}

export type CalendlyRead = { ok: true; event: CalendlyEvent } | { ok: false; event: CalendlyEvent };

/** Reads one invitee of one scheduled event into an appointment event, dead-lettered when anything needed doesn't read. */
export function appointmentEvent(rawEvent: unknown, rawInvitee: unknown, customerKey: string, receivedAt: string): CalendlyRead {
  const problems: string[] = [];
  const ev = obj(rawEvent) ?? {};
  const inv = obj(rawInvitee) ?? {};
  if (!obj(rawEvent)) problems.push("event is not an object");
  if (!obj(rawInvitee)) problems.push("invitee is not an object");
  const eventId = calendlyId(ev.uri);
  const appointmentId = calendlyId(inv.uri);
  if (!eventId) problems.push("event has no id that reads");
  if (!appointmentId) problems.push("invitee has no id that reads");
  const startAt = calendlyTime(ev.start_time);
  const endAt = calendlyTime(ev.end_time);
  if (!startAt) problems.push("event has no start time that reads");
  if (!endAt) problems.push("event has no end time that reads");
  if (startAt && endAt && endAt < startAt) problems.push("event ends before it starts");
  const bookedAt = calendlyTime(inv.created_at);
  if (!bookedAt) problems.push("invitee has no booking time that reads");
  const inviteeStatus = inv.status;
  if (inviteeStatus !== "active" && inviteeStatus !== "canceled") problems.push("invitee status is not active or canceled");

  const cancellation = obj(inv.cancellation) ?? (inviteeStatus === "canceled" ? obj(ev.cancellation) : null);
  const canceledAt = cancellation ? calendlyTime(cancellation.created_at) : null;
  const noShow = obj(inv.no_show);
  const noShowAt = noShow ? calendlyTime(noShow.created_at) : null;
  const status = inviteeStatus === "canceled" ? "canceled" : noShowAt ? "no_show" : "booked";
  const type = status === "canceled" ? CALENDLY_EVENT_TYPES.canceled : status === "no_show" ? CALENDLY_EVENT_TYPES.noShow : CALENDLY_EVENT_TYPES.booked;

  const title = text(ev.name, TITLE_MAX * 2);
  const location = obj(ev.location);
  const locationType = typeof location?.type === "string" ? location.type : undefined;
  const hosts = (Array.isArray(ev.event_memberships) ? ev.event_memberships : []).map((m) => calendlyId(obj(m)?.user)).filter((id): id is string => !!id);
  const answers = Array.isArray(inv.questions_and_answers) ? inv.questions_and_answers.filter((qa) => text(obj(qa)?.answer)).length : 0;
  const tracking = obj(inv.tracking) ?? {};
  const utm = Object.fromEntries(
    (["utm_source", "utm_medium", "utm_campaign"] as const)
      .map((k) => [k.replace("utm_", ""), text(tracking[k], UTM_MAX)] as const)
      .filter(([, v]) => v !== undefined),
  );
  const payment = obj(inv.payment);
  const reconfirmation = obj(inv.reconfirmation);
  const scheduledBy = calendlyId(inv.invitee_scheduled_by);

  const payload: Record<string, unknown> = {
    system: "Calendly",
    appointmentId,
    calendlyEventId: eventId,
    eventTypeId: calendlyId(ev.event_type),
    title: safeTitle(title, inv),
    kind: appointmentKind(title),
    status,
    startAt,
    endAt,
    durationMinutes: startAt && endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000) : undefined,
    location: locationType ? (LOCATION_KINDS[locationType] ?? "unknown") : "unknown",
    hostRefs: hosts.map((id) => `calendly:user:${id}`),
    customerRefs: formCustomerRefs(customerKey, { email: inv.email, phone: inv.text_reminder_number }),
    guestCount: Array.isArray(ev.event_guests) ? ev.event_guests.length : 0,
    answeredQuestions: answers,
    bookedAt,
    bookedByStaffRef: scheduledBy ? `calendly:user:${scheduledBy}` : undefined,
    rescheduled: inv.rescheduled === true,
    replacesAppointmentId: calendlyId(inv.old_invitee),
    replacedByAppointmentId: calendlyId(inv.new_invitee),
    canceledAt: status === "canceled" ? canceledAt : undefined,
    canceledBy: status === "canceled" && (cancellation?.canceler_type === "host" || cancellation?.canceler_type === "invitee") ? cancellation.canceler_type : undefined,
    noShowAt: noShowAt ?? undefined,
    reconfirmed: reconfirmation ? calendlyTime(reconfirmation.confirmed_at) !== null : undefined,
    payment: payment
      ? { provider: payment.provider === "stripe" || payment.provider === "paypal" ? payment.provider : "other", amountCents: cents(payment.amount), currency: text(payment.currency, 3), successful: payment.successful === true }
      : undefined,
    source: Object.keys(utm).length ? utm : undefined,
  };
  const hash = short(payload);
  const ok = problems.length === 0;
  const key = ok ? `calendly:invitee:${appointmentId}:${hash}` : `calendly:unreadable_invitee:${short([rawEvent, rawInvitee])}`;
  const occurredAt = status === "canceled" ? (canceledAt ?? bookedAt) : status === "no_show" ? noShowAt : bookedAt;
  return {
    ok,
    event: {
      id: key.replace(/^calendly:/, "calendly_").replace(/:/g, "_"),
      type,
      // A booking, a cancellation or a no-show happens when Calendly recorded it. One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? (occurredAt ?? undefined) : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: "Calendly", appointmentId: appointmentId ?? null, calendlyEventId: eventId ?? null, problems },
    },
  };
}
