import { createHash } from "node:crypto";
import { gmailNormalizer, type GmailCorrespondent } from "../gmail/normalize.js";
import type { OutlookFolder } from "./client.js";

/**
 * Turns one Exchange Online mailbox's Inbox, Sent Items and calendar into
 * Brain A events, the way Gmail and Google Calendar are:
 *
 * - A message becomes `communication.message_logged`, with its thread,
 *   direction (Sent Items is `sent`, the Inbox `received`), times, whether
 *   it has attachments, its importance, and the sender and the To and Cc
 *   recipients as correspondent references.
 * - A message Graph says left a folder (deleted, or moved out) becomes
 *   `communication.message_removed`.
 * - A calendar event becomes `calendar.appointment_updated`, or
 *   `calendar.appointment_cancelled` once cancelled or deleted, with its
 *   start and end in UTC, all-day and free or busy, whether it repeats, and
 *   the organizer and attendees as correspondent references with their
 *   responses.
 *
 * Never kept: subjects (never asked for), bodies, previews and attachments
 * (Mail.ReadBasic can't see them), an event's subject, body, location and
 * meeting link (Graph sends them with every event, and they often name a
 * customer or a ring), categories, display names and every raw address.
 * Addresses become the same correspondent references Gmail's do, under
 * CORRESPONDENT_HASH_KEY, with the domain kept only for businesses. Graph's
 * long ids are kept as short digests. Drafts are skipped. A message or
 * event without an id or a time that reads is dead-lettered listing why.
 */

export interface OutlookEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const OUTLOOK_EVENTS = {
  message: "communication.message_logged",
  removed: "communication.message_removed",
  appointment: "calendar.appointment_updated",
  cancelled: "calendar.appointment_cancelled",
} as const;

/** Addresses kept per list, so a mailing to hundreds can't make one event huge. The counts stay exact. */
const MAX_PEOPLE = 50;
const ID = /^[A-Za-z0-9+/=_-]{1,512}$/;
// Graph's times: UTC, with up to seven fraction digits.
const TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,7})?Z?$/;
const IMPORTANCE = new Set(["low", "normal", "high"]);
const SHOW_AS = new Set(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]);
const EVENT_TYPES = new Set(["singleInstance", "occurrence", "exception", "seriesMaster"]);
const RESPONSES = new Set(["none", "organizer", "tentativelyAccepted", "accepted", "declined", "notResponded"]);
const ATTENDEE_TYPES = new Set(["required", "optional", "resource"]);
const ADDRESS = /^[^\s@<>()",;:[\]\\]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

const short = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const digest = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);
const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const idOf = (v: unknown): string | undefined => (typeof v === "string" && ID.test(v) ? v : undefined);
const ref = (kind: string, id: string | undefined) => (id === undefined ? undefined : `outlook:${kind}:${digest(id)}`);
const word = (known: Set<string>, v: unknown) => (typeof v === "string" && known.has(v) ? v : undefined);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/** A Graph time (UTC, written with or without its Z) as an ISO time, or undefined. */
export function outlookTime(v: unknown): string | undefined {
  const m = typeof v === "string" ? TIME.exec(v) : null;
  if (!m) return undefined;
  // Date.parse turns down a minute or second of 60, and reads up to seven fraction digits.
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}Z`);
  // It rolls a day like 02-30, or a time of 24:00:00, into the next day, so the day must read back as itself.
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== m[1]) return undefined;
  return new Date(t).toISOString();
}

/** A dateTimeTimeZone in UTC, which Graph sends when no time zone is asked for, or undefined for any other zone. */
const when = (v: unknown) => (obj(v).timeZone === "UTC" ? outlookTime(obj(v).dateTime) : undefined);

export interface OutlookContext {
  receivedAt: string;
  /** The instance's CORRESPONDENT_HASH_KEY. */
  correspondentKey: string;
}

export function outlookNormalizer(correspondentKey: string) {
  const { correspondent } = gmailNormalizer({ correspondentKey });
  const address = (v: unknown): GmailCorrespondent | undefined => {
    const a = obj(obj(v).emailAddress).address;
    const bare = typeof a === "string" ? a.trim().toLowerCase() : "";
    return ADDRESS.test(bare) ? correspondent(bare) : undefined;
  };
  const people = (v: unknown) => {
    const all = list(v).map(address).filter((c) => c !== undefined);
    const unique = [...new Map(all.map((c) => [c.correspondentId, c])).values()];
    return { list: unique.slice(0, MAX_PEOPLE), count: unique.length };
  };

  function make(kind: string, type: string, id: string | undefined, problems: string[], raw: unknown, occurredAt: string | undefined, payload: Record<string, unknown>, receivedAt: string): OutlookEvent {
    const ok = problems.length === 0;
    const idempotencyKey = ok ? `outlook:${kind}:${digest(id!)}:${short(payload)}` : `outlook:unreadable_${kind}:${short(raw)}`;
    return { id: idempotencyKey.replace(/:/g, "_"), type, occurredAt: ok ? occurredAt : undefined, receivedAt, idempotencyKey, payload: ok ? payload : { system: "Outlook", problems } };
  }

  return {
    /** A message's event, or none for a draft. */
    message(folder: OutlookFolder, raw: unknown, receivedAt: string): OutlookEvent[] {
      const r = obj(raw);
      const id = idOf(r.id);
      if (r["@removed"]) {
        if (!id) return [make("message", OUTLOOK_EVENTS.removed, id, ["removed message has no id that reads"], raw, undefined, {}, receivedAt)];
        return [make("message", OUTLOOK_EVENTS.removed, id, [], raw, receivedAt, { system: "Outlook", channel: "email", messageId: ref("message", id), folder }, receivedAt)];
      }
      if (r.isDraft === true) return [];
      const sent = folder === "sentitems";
      const sentAt = outlookTime(r.sentDateTime);
      const deliveredAt = outlookTime(r.receivedDateTime);
      const at = sent ? (sentAt ?? deliveredAt) : deliveredAt;
      const problems = [...(id ? [] : ["message has no id that reads"]), ...(at ? [] : ["message has no time that reads"])];
      const to = people(r.toRecipients);
      const cc = people(r.ccRecipients);
      const payload = defined({
        system: "Outlook",
        channel: "email",
        messageId: ref("message", id),
        threadId: ref("thread", idOf(r.conversationId)),
        folder,
        direction: sent ? "sent" : "received",
        sentAt,
        deliveredAt,
        from: address(r.from),
        to: to.list,
        cc: cc.list,
        recipientCount: to.count + cc.count,
        hasAttachments: typeof r.hasAttachments === "boolean" ? r.hasAttachments : undefined,
        importance: word(IMPORTANCE, r.importance),
      });
      return [make("message", OUTLOOK_EVENTS.message, id, problems, raw, at, payload, receivedAt)];
    },

    /** A calendar event's event. */
    appointment(raw: unknown, receivedAt: string): OutlookEvent {
      const r = obj(raw);
      const id = idOf(r.id);
      if (r["@removed"]) {
        return make("event", OUTLOOK_EVENTS.cancelled, id, id ? [] : ["removed event has no id that reads"], raw, receivedAt, { system: "Outlook", appointmentId: ref("event", id), status: "cancelled", removed: true }, receivedAt);
      }
      const updatedAt = outlookTime(r.lastModifiedDateTime);
      const problems = [...(id ? [] : ["event has no id that reads"]), ...(updatedAt ? [] : ["event has no time that reads"])];
      const cancelled = r.isCancelled === true;
      const attendees = list(r.attendees).flatMap((x) => {
        const a = obj(x);
        const who = address(a);
        return who ? [defined({ ...who, response: word(RESPONSES, obj(a.status).response), kind: word(ATTENDEE_TYPES, a.type) })] : [];
      });
      const payload = defined({
        system: "Outlook",
        appointmentId: ref("event", id),
        status: cancelled ? "cancelled" : "confirmed",
        type: word(EVENT_TYPES, r.type),
        seriesId: ref("event", idOf(r.seriesMasterId)),
        start: when(r.start),
        end: when(r.end),
        allDay: typeof r.isAllDay === "boolean" ? r.isAllDay : undefined,
        showAs: word(SHOW_AS, r.showAs),
        online: typeof r.isOnlineMeeting === "boolean" ? r.isOnlineMeeting : undefined,
        organizer: address(r.organizer),
        attendees: attendees.slice(0, MAX_PEOPLE),
        attendeeCount: attendees.length,
        createdAt: outlookTime(r.createdDateTime),
        updatedAt,
      });
      return make("event", cancelled ? OUTLOOK_EVENTS.cancelled : OUTLOOK_EVENTS.appointment, id, problems, raw, updatedAt, payload, receivedAt);
    },
  };
}

export type OutlookNormalizer = ReturnType<typeof outlookNormalizer>;
