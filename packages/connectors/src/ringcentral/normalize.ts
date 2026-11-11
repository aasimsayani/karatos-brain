import { createHash } from "node:crypto";
import { quoCustomerRefs, quoTime } from "../openphone/normalize.js";

/**
 * Turns RingCentral calls, texts and voicemail into the same events Quo's
 * and Twilio's give: `communication.call_logged` and
 * `communication.message_logged`, so the store sees how fast it answers
 * customers whichever phone system it uses. Only what that needs is kept:
 *
 * - Text, subjects, voicemail audio, transcripts, recordings, caller names
 *   and locations are never read into an event: they are the customer's
 *   own words or say who the customer is.
 * - The customer's numbers become the same customer references Quo, custom
 *   forms, Klaviyo and AvaTax make (an HMAC under CUSTOMER_REF_KEY), so the
 *   same person lines up across systems without the number being kept.
 *   Withheld callers and short codes get none.
 *
 * Each event is keyed by the call or message and a digest of what was kept,
 * so reading it again is a duplicate and a change (a read text, a deleted
 * voicemail) is a new event. One without an id or a time that reads is
 * dead-lettered listing what was wrong.
 */

export interface RingCentralEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const RINGCENTRAL_CALL_EVENT = "communication.call_logged";
export const RINGCENTRAL_MESSAGE_EVENT = "communication.message_logged";
const SYSTEM = "RingCentral";
/** An incoming call that ended in one of these wasn't picked up. */
const MISSED = new Set(["Missed", "Voicemail", "Rejected", "Busy", "No Answer", "Hang Up", "Abandoned", "Declined"]);
const WORD = /^[A-Za-z][A-Za-z -]{0,39}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const word = (v: unknown) => (typeof v === "string" && WORD.test(v) ? v : undefined);
/** RingCentral writes some ids as numbers and some as strings. */
const idOf = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? String(v) : typeof v === "string" && ID.test(v) ? v : undefined);
const direction = (v: unknown) => (v === "Inbound" ? "inbound" : v === "Outbound" ? "outbound" : undefined);

export interface RingCentralContext {
  customerKey: string;
  receivedAt: string;
}

export type RingCentralRead = { ok: boolean; event: RingCentralEvent };

function read(kind: "call" | "message", type: string, raw: unknown, problems: string[], id: string | undefined, at: string | null, payload: Record<string, unknown>, receivedAt: string): RingCentralRead {
  const ok = problems.length === 0;
  const key = ok ? `ringcentral:${kind}:${id}:${short(payload)}` : `ringcentral:unreadable_${kind}:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at! : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, [`${kind}Id`]: id ?? null, problems },
    },
  };
}

export function ringCentralCallEvent(raw: unknown, ctx: RingCentralContext): RingCentralRead {
  const problems: string[] = [];
  const c = obj(raw);
  if (c !== raw) problems.push("call is not an object");
  const id = idOf(c.id);
  if (!id) problems.push("call has no id that reads");
  const startedAt = quoTime(c.startTime);
  if (!startedAt) problems.push("call has no start time that reads");
  const way = direction(c.direction);
  if (!way) problems.push("call direction is not Inbound or Outbound");
  const result = word(c.result);
  if (!result) problems.push("call has no result that reads");

  // The customer is who called in, or who the store called.
  const customer = obj(way === "inbound" ? c.from : c.to).phoneNumber;
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    channel: c.type === "Fax" ? "fax" : "voice",
    callId: `ringcentral:call:${id}`,
    customerRefs: quoCustomerRefs(ctx.customerKey, [customer]),
    withheldCaller: typeof customer !== "string",
    direction: way,
    action: word(c.action),
    result,
    missed: way === "inbound" && MISSED.has(result!),
    durationSeconds: Number.isSafeInteger(c.duration) && (c.duration as number) >= 0 ? c.duration : undefined,
    startedAt: startedAt ?? undefined,
  };
  return read("call", RINGCENTRAL_CALL_EVENT, raw, problems, id, startedAt, payload, ctx.receivedAt);
}

export function ringCentralMessageEvent(raw: unknown, ctx: RingCentralContext): RingCentralRead {
  const problems: string[] = [];
  const m = obj(raw);
  if (m !== raw) problems.push("message is not an object");
  const id = idOf(m.id);
  if (!id) problems.push("message has no id that reads");
  const sentAt = quoTime(m.creationTime);
  if (!sentAt) problems.push("message has no time that reads");
  const way = direction(m.direction);
  if (!way) problems.push("message direction is not Inbound or Outbound");
  const voicemail = m.type === "VoiceMail";
  if (!voicemail && m.type !== "SMS") problems.push("message is not a text or a voicemail");

  // The customer is who sent an incoming text or voicemail, or who an outgoing text went to.
  const customers = way === "outbound" ? (Array.isArray(m.to) ? m.to : []).map((t) => obj(t).phoneNumber) : [obj(m.from).phoneNumber];
  // A voicemail's recording is the attachment that has a length.
  const seconds = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => obj(a).vmDuration).find((s) => Number.isSafeInteger(s) && (s as number) >= 0);
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    channel: voicemail ? "voicemail" : "sms",
    messageId: `ringcentral:message:${id}`,
    conversationId: idOf(m.conversationId) && `ringcentral:conversation:${idOf(m.conversationId)}`,
    customerRefs: quoCustomerRefs(ctx.customerKey, customers),
    direction: way,
    status: word(m.messageStatus),
    read: m.readStatus === "Read",
    deleted: m.availability === "Deleted" || m.availability === "Purged",
    // How long, not what: enough to tell a quick reply from a long one.
    textLength: !voicemail && typeof m.subject === "string" ? m.subject.length : undefined,
    voicemailSeconds: voicemail ? seconds : undefined,
    transcription: voicemail ? word(m.vmTranscriptionStatus) : undefined,
    sentAt: sentAt ?? undefined,
    changedAt: quoTime(m.lastModifiedTime) ?? undefined,
  };
  return read("message", RINGCENTRAL_MESSAGE_EVENT, raw, problems, id, sentAt, payload, ctx.receivedAt);
}
