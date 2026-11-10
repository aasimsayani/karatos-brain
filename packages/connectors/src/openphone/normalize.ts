import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";

/**
 * Turns Quo calls and texts into the same events Twilio's give:
 * `communication.call_logged` and `communication.message_logged`, so the
 * store sees how fast it answers customers whichever phone system it uses.
 * Only what that needs is kept:
 *
 * - Message text, media links, call summaries, voicemails, recordings and
 *   transcripts are never read into an event: they are the customer's own
 *   words.
 * - The customer's numbers become the same customer references custom
 *   forms, Klaviyo and AvaTax make (an HMAC under CUSTOMER_REF_KEY), so
 *   the same person lines up across systems without the number being kept.
 *   Withheld callers and short codes get none.
 * - The store's line is kept as Quo's phone number id, and staff as Quo's
 *   user ids, which name no one outside Quo.
 *
 * Each event is keyed by the call or message and a digest of what was kept,
 * so reading it again is a duplicate and a change (a status, a duration) is
 * a new event. A call or message without an id or a time that reads is
 * dead-lettered listing what was wrong.
 */

export interface QuoEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const QUO_CALL_EVENT = "communication.call_logged";
export const QUO_MESSAGE_EVENT = "communication.message_logged";
const SYSTEM = "Quo";
const CALL_STATUSES = new Set(["queued", "initiated", "ringing", "in-progress", "completed", "busy", "failed", "no-answer", "canceled", "missed", "answered", "forwarded", "abandoned"]);
/** An incoming call that ended in one of these wasn't picked up. */
const MISSED = new Set(["busy", "no-answer", "canceled", "missed", "abandoned"]);
const MESSAGE_STATUSES = new Set(["queued", "sent", "delivered", "undelivered", "received", "failed"]);
const MAX_CUSTOMERS = 10;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const word = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : undefined);
const PHONE_NUMBER_ID = /^PN[A-Za-z0-9]{1,40}$/;
const ACTOR_ID = /^(US|SYU)[A-Za-z0-9]{1,40}$/;

/** An ISO time as Quo writes it, as UTC with milliseconds, or null when it isn't one. */
export function quoTime(value: unknown): string | null {
  const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!m) return null;
  // Date.parse rolls an impossible day (Feb 30) into the next month, so the day must read back as itself.
  const day = m[1]!;
  const t = Date.parse(m[0]);
  return t >= 0 && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day ? new Date(t).toISOString() : null;
}

/** The customer references for a number, when it is one: E.164, not a withheld caller or short code. */
export function quoCustomerRefs(key: string, numbers: unknown[]): string[] {
  const refs = numbers
    .filter((n): n is string => typeof n === "string" && /^\+[1-9]\d*$/.test(n))
    .slice(0, MAX_CUSTOMERS)
    .flatMap((phone) => formCustomerRefs(key, { phone }));
  return [...new Set(refs)].sort();
}

export interface QuoContext {
  customerKey: string;
  receivedAt: string;
}

export type QuoRead = { ok: boolean; event: QuoEvent };

function read(kind: "call" | "message", type: string, raw: unknown, problems: string[], id: string | undefined, at: string | null, payload: Record<string, unknown>, receivedAt: string): QuoRead {
  const ok = problems.length === 0;
  const key = ok ? `openphone:${kind}:${id}:${short(payload)}` : `openphone:unreadable_${kind}:${short(raw)}`;
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

export function quoCallEvent(raw: unknown, ctx: QuoContext): QuoRead {
  const problems: string[] = [];
  const c = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("call is not an object");
  const id = word(c.id, /^AC[A-Za-z0-9]{1,64}$/);
  if (!id) problems.push("call has no id that reads");
  const startedAt = quoTime(c.createdAt);
  if (!startedAt) problems.push("call has no start time that reads");
  const direction = c.direction === "incoming" || c.direction === "outgoing" ? c.direction : undefined;
  if (!direction) problems.push("call direction is not incoming or outgoing");
  const status = typeof c.status === "string" && CALL_STATUSES.has(c.status) ? c.status : undefined;
  if (!status) problems.push("call status is not one Quo documents");

  // Every party is listed, the store's line included; a number outside the workspace has no actor.
  const outside = (Array.isArray(c.participants) ? c.participants : []).filter((p) => isObject(p) && p.actorId === null).map((p) => (p as Record<string, unknown>).phoneNumber);
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    channel: "voice",
    callId: id ? `openphone:call:${id}` : undefined,
    customerRefs: quoCustomerRefs(ctx.customerKey, outside),
    withheldCaller: outside.some((n) => typeof n === "string" && /^(anonymous|blocked|restricted)$/i.test(n)),
    storeLineId: word(c.phoneNumberId, PHONE_NUMBER_ID),
    direction: direction === "incoming" ? "inbound" : "outbound",
    status,
    missed: direction === "incoming" && status !== undefined && MISSED.has(status),
    answeredBy: word(c.answeredBy, ACTOR_ID),
    durationSeconds: Number.isSafeInteger(c.duration) && (c.duration as number) >= 0 ? c.duration : undefined,
    forwarded: c.forwardedTo !== null && c.forwardedTo !== undefined,
    aiHandled: c.aiHandled === "ai-agent",
    startedAt: startedAt ?? undefined,
    answeredAt: quoTime(c.answeredAt) ?? undefined,
    endedAt: quoTime(c.completedAt) ?? undefined,
  };
  return read("call", QUO_CALL_EVENT, raw, problems, id, startedAt, payload, ctx.receivedAt);
}

export function quoMessageEvent(raw: unknown, ctx: QuoContext): QuoRead {
  const problems: string[] = [];
  const m = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("message is not an object");
  const id = word(m.id, /^AC[A-Za-z0-9]{1,64}$/);
  if (!id) problems.push("message has no id that reads");
  const sentAt = quoTime(m.createdAt);
  if (!sentAt) problems.push("message has no time that reads");
  const direction = m.direction === "incoming" || m.direction === "outgoing" ? m.direction : undefined;
  if (!direction) problems.push("message direction is not incoming or outgoing");
  const status = typeof m.status === "string" && MESSAGE_STATUSES.has(m.status) ? m.status : undefined;
  if (!status) problems.push("message status is not one Quo documents");

  // The customer is who sent an incoming text, or who an outgoing one went to.
  const customers = direction === "incoming" ? [m.from] : Array.isArray(m.to) ? m.to : [];
  const media = Array.isArray(m.media) ? m.media.length : 0;
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    channel: media > 0 ? "mms" : "sms",
    messageId: id ? `openphone:message:${id}` : undefined,
    conversationId: word(m.conversationId, /^CN[A-Za-z0-9]{1,64}$/),
    customerRefs: quoCustomerRefs(ctx.customerKey, customers),
    storeLineId: word(m.phoneNumberId, PHONE_NUMBER_ID),
    direction: direction === "incoming" ? "inbound" : "outbound",
    status,
    sentBy: word(m.userId, ACTOR_ID),
    mediaCount: media,
    // How long, not what: enough to tell a quick reply from a long one.
    textLength: typeof m.text === "string" ? m.text.length : undefined,
    sentAt: sentAt ?? undefined,
    statusAt: quoTime(m.updatedAt) ?? undefined,
  };
  return read("message", QUO_MESSAGE_EVENT, raw, problems, id, sentAt, payload, ctx.receivedAt);
}
