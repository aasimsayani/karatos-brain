import { createHash, createHmac } from "node:crypto";
import { appointmentKind, calendlyTime } from "../calendly/normalize.js";
import { formCustomerRefs, normalizeEmail } from "../custom_forms/customer.js";

/**
 * Turns a past Zoom meeting, with its participant report, into one Brain A
 * event: `appointment.held`, a virtual consultation that took place. It
 * sits beside Calendly's bookings, so a booked video appointment can be
 * matched to the meeting that was held for it.
 *
 * Meetings are personal, so the event keeps the shape of the meeting and
 * drops the people:
 *
 * - each participant's email address only makes the keyed customer
 *   reference custom forms, Klaviyo and Calendly make, so the meeting links
 *   to the person's bookings and forms. Names, addresses, devices, IP
 *   addresses and locations are never kept;
 * - the host is staff: kept as a keyed host reference, never by name or
 *   address, and left out of the customer references;
 * - the topic is kept only when it doesn't carry a participant's or the
 *   host's name or email, since a one-off meeting is often named after the
 *   person; its kind (bridal, repair and so on) is read from it either way;
 * - recordings, chat, transcripts and summaries are never read, only
 *   whether the meeting used them.
 *
 * The event is keyed by the meeting's UUID (one per time a meeting is held)
 * and a digest of what was kept, so reading it again is a duplicate and a
 * change is a new event. A meeting without a UUID or times that read is
 * dead-lettered listing what was wrong.
 */

export interface ZoomEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const ZOOM_HELD_EVENT = "appointment.held";
/** A meeting instance's UUID: base64 text, which may hold / and +. */
export const ZOOM_UUID = /^[A-Za-z0-9+/=]{8,64}$/;
const MEETING_ID = /^\d{9,12}$/;
const TITLE_MAX = 80;
/** Customer references kept per meeting; a webinar-sized meeting isn't a consultation. */
const MAX_CUSTOMERS = 20;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined);
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

/** The host as staff: a reference keyed like customer ones, so the address can't be read back or guessed. */
export function zoomHostRef(key: string, email: unknown): string | undefined {
  const address = normalizeEmail(email);
  return address ? `zoom:host:${createHmac("sha256", key).update(`zoom-host:${address}`, "utf8").digest("hex").slice(0, 24)}` : undefined;
}

/** The topic, unless one of the names or addresses given appears in it. */
export function zoomSafeTopic(topic: string | undefined, people: unknown[]): string | undefined {
  if (!topic) return undefined;
  const lower = topic.toLowerCase();
  const words = people
    .flatMap((v) => (typeof v === "string" ? [v.toLowerCase(), ...v.toLowerCase().split(/[\s,.@]+/)] : []))
    .filter((w) => w.length >= 2);
  // Longer words are matched anywhere; short names such as Al or Li only as whole words.
  const titleWords = new Set(lower.split(/[^\p{L}\p{N}]+/u));
  return words.some((w) => (w.length >= 3 ? lower.includes(w) : titleWords.has(w))) ? undefined : topic.slice(0, TITLE_MAX);
}

export interface ZoomContext {
  customerKey: string;
  receivedAt: string;
}

export type ZoomRead = { ok: boolean; event: ZoomEvent };

/**
 * Reads one meeting from the meeting history and its participant report
 * (null when Zoom had none for it) into a held appointment, dead-lettered
 * when anything needed doesn't read.
 */
export function zoomMeetingEvent(raw: unknown, participants: unknown[] | null, ctx: ZoomContext): ZoomRead {
  const problems: string[] = [];
  const m = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("meeting is not an object");
  const uuid = typeof m.meeting_uuid === "string" && ZOOM_UUID.test(m.meeting_uuid) ? m.meeting_uuid : undefined;
  if (!uuid) problems.push("meeting has no UUID that reads");
  const startAt = calendlyTime(m.start_time);
  const endAt = calendlyTime(m.end_time);
  if (!startAt) problems.push("meeting has no start time that reads");
  if (!endAt) problems.push("meeting has no end time that reads");
  if (startAt && endAt && endAt < startAt) problems.push("meeting ends before it starts");

  const hostEmail = normalizeEmail(m.host_email);
  const rows = (participants ?? []).filter(isObject);
  const guests = rows.filter((p) => normalizeEmail(p.user_email) === undefined || normalizeEmail(p.user_email) !== hostEmail);
  const emails = [...new Set(guests.map((p) => normalizeEmail(p.user_email)).filter((e): e is string => e !== undefined))];
  const customerRefs = [...new Set(emails.slice(0, MAX_CUSTOMERS).flatMap((email) => formCustomerRefs(ctx.customerKey, { email })))].sort();
  // A person who drops and rejoins is listed once per join; they count once, by Zoom's participant id or else their name.
  const attendees = new Set(guests.map((p) => text(p.participant_user_id, 64) ?? text(p.user_email, 320)?.toLowerCase() ?? text(p.name, 200) ?? short(p)));
  const joins = guests.map((p) => calendlyTime(p.join_time)).filter((t): t is string => t !== null).sort();

  const topic = text(m.topic, TITLE_MAX * 2);
  const features = isObject(m.feature_used) ? m.feature_used : {};
  const uses = (...names: string[]) => names.some((n) => features[n] === true);
  const meetingId = typeof m.meeting_id === "number" || typeof m.meeting_id === "string" ? String(m.meeting_id) : "";

  const payload: Record<string, unknown> = {
    system: "Zoom",
    meetingUuid: uuid,
    meetingId: MEETING_ID.test(meetingId) ? meetingId : undefined,
    title: zoomSafeTopic(topic, [m.host_display_name, m.host_email, ...rows.flatMap((p) => [p.name, p.user_email])]),
    kind: appointmentKind(topic),
    startAt,
    endAt,
    durationMinutes: count(m.duration),
    hostRef: zoomHostRef(ctx.customerKey, m.host_email),
    customerRefs,
    participantsRead: participants !== null,
    participantCount: count(m.participants),
    attendeeCount: participants === null ? undefined : attendees.size,
    firstGuestJoinedAt: joins[0],
    recorded: uses("record_to_cloud", "record_to_computer"),
    screenShared: uses("screen_sharing"),
    summarized: uses("meeting_summary"),
  };
  const ok = problems.length === 0;
  const hash = ok ? short(payload) : short(raw);
  const key = ok ? `zoom:meeting:${uuid}:${hash}` : `zoom:unreadable_meeting:${hash}`;
  return {
    ok,
    event: {
      // The UUID in hex, so two UUIDs that differ only in + and / never share an id.
      id: ok ? `zoom_meeting_${Buffer.from(uuid!).toString("hex")}_${hash}` : `zoom_unreadable_meeting_${hash}`,
      type: ZOOM_HELD_EVENT,
      occurredAt: ok ? (startAt ?? undefined) : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: "Zoom", meetingUuid: uuid ?? null, problems },
    },
  };
}
