import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";

/**
 * Turns Gorgias tickets and their messages into events:
 *
 * - `communication.ticket_updated` for each ticket: its status, channel,
 *   tags, who it is assigned to, whether it is spam or trashed, its
 *   satisfaction score and its times, so clienteling, sales and repairs
 *   see what customers asked and how fast the store answered.
 * - `communication.message_logged` for each message, as Quo's, Twilio's
 *   and Gmail's are: who wrote it (the store, the customer, or an internal
 *   note), the channel, how long it was and when it was sent.
 *
 * Message text, subjects, attachments, customer names and notes are never
 * read into an event. The customer's email becomes the same customer
 * reference custom forms, Klaviyo, Quo and AvaTax make (an HMAC under
 * CUSTOMER_REF_KEY), so the same person lines up across systems without
 * the address being kept. Staff are Gorgias's user ids, which name no one
 * outside Gorgias.
 *
 * Each event is keyed by the ticket or message and a digest of what was
 * kept, so reading it again is a duplicate and a change is a new event.
 * One without an id or a time that reads is dead-lettered listing what
 * was wrong.
 */

export interface GorgiasEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const GORGIAS_TICKET_EVENT = "communication.ticket_updated";
export const GORGIAS_MESSAGE_EVENT = "communication.message_logged";
const SYSTEM = "Gorgias";
const MAX_TAGS = 20;
const WORD = /^[a-z][a-z0-9_-]{0,39}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} _&'./-]{0,39}$/u;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const word = (v: unknown) => (typeof v === "string" && WORD.test(v) ? v : undefined);
const idOf = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : undefined);
const user = (v: unknown) => (idOf(v) ? `gorgias_user:${v}` : undefined);

/**
 * A time as Gorgias writes it, as UTC with milliseconds, or null when it isn't one. Gorgias writes
 * times without an offset, such as 2019-07-05T14:42:00.384938, and they are UTC.
 */
export function gorgiasTime(value: unknown): string | null {
  const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,6})?(?:Z|\+00:00)?$/.exec(value) : null;
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}Z`);
  // Date.parse rolls an impossible day (Feb 30) into the next month, so the day must read back as itself.
  return t >= 0 && new Date(t).toISOString().slice(0, 10) === m[1] ? new Date(t).toISOString() : null;
}

export interface GorgiasContext {
  customerKey: string;
  receivedAt: string;
}

export type GorgiasRead = { ok: boolean; event: GorgiasEvent };

function read(kind: "ticket" | "message", type: string, raw: unknown, problems: string[], id: number | undefined, at: string | null, payload: Record<string, unknown>, receivedAt: string): GorgiasRead {
  const ok = problems.length === 0;
  const key = ok ? `gorgias:${kind}:${id}:${short(payload)}` : `gorgias:unreadable_${kind}:${short(raw)}`;
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

/** The tags' names, which the store chose (repair, return, sizing), sorted and capped. */
function tagsOf(v: unknown): string[] {
  const names = (Array.isArray(v) ? v : []).map((t) => obj(t).name).filter((n): n is string => typeof n === "string" && TAG.test(n.trim()));
  return [...new Set(names.map((n) => n.trim().toLowerCase()))].sort().slice(0, MAX_TAGS);
}

export function gorgiasTicketEvent(raw: unknown, ctx: GorgiasContext): GorgiasRead {
  const problems: string[] = [];
  const t = obj(raw);
  if (t !== raw) problems.push("ticket is not an object");
  const id = idOf(t.id);
  if (!id) problems.push("ticket has no id that reads");
  const createdAt = gorgiasTime(t.created_datetime);
  if (!createdAt) problems.push("ticket has no creation time that reads");
  const updatedAt = gorgiasTime(t.updated_datetime) ?? createdAt;
  const status = word(t.status);
  if (!status) problems.push("ticket has no status that reads");

  const score = obj(t.satisfaction_survey).score;
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    ticketId: id ? `gorgias:ticket:${id}` : undefined,
    customerRefs: formCustomerRefs(ctx.customerKey, { email: obj(t.customer).email }),
    status,
    channel: word(t.channel),
    via: word(t.via),
    language: typeof t.language === "string" && /^[a-z]{2}$/.test(t.language) ? t.language : undefined,
    tags: tagsOf(t.tags),
    assignedTo: user(obj(t.assignee_user).id),
    startedByStore: t.from_agent === true,
    spam: t.spam === true,
    trashed: gorgiasTime(t.trashed_datetime) !== null,
    unread: t.is_unread === true,
    satisfactionScore: Number.isInteger(score) && (score as number) >= 1 && (score as number) <= 5 ? score : undefined,
    createdAt: createdAt ?? undefined,
    openedAt: gorgiasTime(t.opened_datetime) ?? undefined,
    lastReceivedAt: gorgiasTime(t.last_received_message_datetime) ?? undefined,
    lastMessageAt: gorgiasTime(t.last_message_datetime) ?? undefined,
    closedAt: gorgiasTime(t.closed_datetime) ?? undefined,
    snoozedUntil: gorgiasTime(t.snooze_datetime) ?? undefined,
    updatedAt: updatedAt ?? undefined,
  };
  return read("ticket", GORGIAS_TICKET_EVENT, raw, problems, id, updatedAt, payload, ctx.receivedAt);
}

export function gorgiasMessageEvent(raw: unknown, ctx: GorgiasContext): GorgiasRead {
  const problems: string[] = [];
  const m = obj(raw);
  if (m !== raw) problems.push("message is not an object");
  const id = idOf(m.id);
  if (!id) problems.push("message has no id that reads");
  const ticket = idOf(m.ticket_id);
  if (!ticket) problems.push("message has no ticket that reads");
  const createdAt = gorgiasTime(m.created_datetime);
  if (!createdAt) problems.push("message has no time that reads");
  if (typeof m.public !== "boolean" || typeof m.from_agent !== "boolean") problems.push("message doesn't say whether it is public and who wrote it");

  // An internal note is the store talking to itself; otherwise the store wrote out, or the customer wrote in.
  const direction = m.public === false ? "internal" : m.from_agent === true ? "outbound" : "inbound";
  const source = obj(m.source);
  const customers = direction === "inbound" ? [obj(source.from).address] : direction === "outbound" ? (Array.isArray(source.to) ? source.to : []).map((r) => obj(r).address) : [];
  const refs = [...new Set(customers.slice(0, 10).flatMap((email) => formCustomerRefs(ctx.customerKey, { email })))].sort();
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    channel: word(m.channel),
    via: word(m.via),
    messageId: id ? `gorgias:message:${id}` : undefined,
    conversationId: ticket ? `gorgias:ticket:${ticket}` : undefined,
    customerRefs: refs,
    direction,
    sentBy: m.from_agent === true ? user(obj(m.sender).id) : undefined,
    // How long, not what: enough to tell a quick reply from a long one.
    textLength: typeof m.body_text === "string" ? m.body_text.length : undefined,
    attachmentCount: Array.isArray(m.attachments) ? m.attachments.length : 0,
    byRule: idOf(m.rule_id) !== undefined,
    failed: gorgiasTime(m.failed_datetime) !== null,
    deleted: gorgiasTime(m.deleted_datetime) !== null,
    sentAt: gorgiasTime(m.sent_datetime) ?? createdAt ?? undefined,
    openedAt: gorgiasTime(m.opened_datetime) ?? undefined,
  };
  return read("message", GORGIAS_MESSAGE_EVENT, raw, problems, id, createdAt, payload, ctx.receivedAt);
}
