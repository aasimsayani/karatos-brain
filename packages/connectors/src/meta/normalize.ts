import { createHash, createHmac } from "node:crypto";
import { checkCustomerRefKey, formCustomerRefs } from "../custom_forms/customer.js";
import { META_NODE_ID, type MetaPlatform } from "./client.js";

/**
 * Messenger, Instagram and WhatsApp messages as the same event Quo and
 * Twilio give, `communication.message_logged`, so the store sees how fast
 * it answers customers whichever app they write in. Only what that needs
 * is kept, as the Quo connector does:
 *
 * - Message text, attachments, shares, story links and reactions are never
 *   read into an event: they are the customer's own words. Text is kept
 *   only as its length, attachments only as a count.
 * - No names, emails, usernames or phone numbers. A WhatsApp customer's
 *   number (wa_id) becomes the same customer reference custom forms, Quo
 *   and Klaviyo make (an HMAC under CUSTOMER_REF_KEY). A Messenger or
 *   Instagram customer has only an id scoped to the Page or account, which
 *   formCustomerRefs doesn't take, so it becomes a `meta_customer:` HMAC
 *   under the same key, never the raw id.
 * - Conversation and message ids can name the people in them, so they are
 *   kept only as HMACs under that key too.
 * - The store's own side is kept as the Page id, the Instagram account id
 *   or the WhatsApp phone number id, which name no customer.
 *
 * Each event is keyed by the message and a digest of what was kept, so
 * reading it again is a duplicate and a change (a WhatsApp status) is a new
 * event. One without an id, time or sender that reads is dead-lettered
 * listing what was wrong.
 */

export interface MetaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export type MetaRead = { ok: boolean; event: MetaEvent };
export type MetaChannel = MetaPlatform | "whatsapp";

export const META_MESSAGE_EVENT = "communication.message_logged";
const SYSTEMS: Readonly<Record<MetaChannel, string>> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" };
export const META_CUSTOMER_PREFIX = "meta_customer:";
/** A Page-scoped or Instagram-scoped id. The docs give no pattern; they are numeric in the examples. */
const SCOPED_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CUSTOMERS = 10;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify([value])).digest("hex").slice(0, 12);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/**
 * A time as Graph writes it ("2022-07-12T19:11:07+0000"), or with a colon in
 * the offset, or Z, as UTC with milliseconds. Undefined when it isn't one.
 */
export function metaTime(value: unknown): string | undefined {
  const m = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(?:Z|([+-]\d{2}):?(\d{2}))$/.exec(value) : null;
  if (!m) return undefined;
  const day = m[1]!;
  const t = Date.parse(`${day}${m[2]}${m[3] === undefined ? "Z" : `${m[3]}:${m[4]}`}`);
  // Date.parse rolls an impossible day (Feb 30) into the next month, so the day must read back as itself.
  return t >= 0 && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day ? new Date(t).toISOString() : undefined;
}

/** Unix seconds as WhatsApp writes them, a string of digits, as an ISO time. Undefined otherwise. */
export function whatsappTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,11}$/.test(value)) return undefined;
  return new Date(Number(value) * 1000).toISOString();
}

/** Keyed digests under CUSTOMER_REF_KEY, so no id that could name a person is kept. */
export function metaRefs(customerKey: string) {
  const key = checkCustomerRefKey(customerKey);
  const mac = (text: string) => createHmac("sha256", key).update(text, "utf8").digest("hex").slice(0, 32);
  return {
    /** A conversation or message, as `meta:<channel>:<kind>:<digest>`. */
    node: (channel: MetaChannel, kind: "conversation" | "message", id: string) => `meta:${channel}:${kind}:${mac(`karatos:meta:v1:${channel}:${kind}:${id}`)}`,
    /** A Messenger or Instagram customer, by the id scoped to the Page or account. */
    person: (channel: MetaPlatform, scopedId: string) => `${META_CUSTOMER_PREFIX}${mac(`karatos:customer:v1:meta:${channel}:${scopedId}`)}`,
    /** A WhatsApp customer, by number: the same reference forms, Quo and Klaviyo make. */
    phone: (waId: unknown) => (typeof waId === "string" && /^[1-9][0-9]{6,14}$/.test(waId) ? formCustomerRefs(key, { phone: waId }) : []),
  };
}
export type MetaRefs = ReturnType<typeof metaRefs>;

function read(channel: MetaChannel, raw: unknown, problems: string[], messageRef: string | undefined, at: string | undefined, payload: Record<string, unknown>, receivedAt: string): MetaRead {
  const ok = problems.length === 0;
  const key = ok ? `${messageRef}:${short(payload)}` : `meta:${channel}:unreadable_message:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type: META_MESSAGE_EVENT,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEMS[channel], channel, messageId: messageRef ?? null, problems },
    },
  };
}

export interface MetaMessageContext {
  channel: MetaPlatform;
  /** The store's side: the Page id for Messenger, the Instagram account id for Instagram. */
  businessId: string;
  refs: MetaRefs;
  /** The conversation's reference, from metaRefs().node. */
  conversationRef: string;
  receivedAt: string;
}

/** A Messenger or Instagram message read with META_MESSAGE_FIELDS. */
export function metaMessageEvent(raw: unknown, ctx: MetaMessageContext): MetaRead {
  const problems: string[] = [];
  const m = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("message is not an object");
  const id = typeof m.id === "string" && META_NODE_ID.test(m.id) ? m.id : undefined;
  if (!id) problems.push("message has no id that reads");
  const sentAt = metaTime(m.created_time);
  if (!sentAt) problems.push("message has no time that reads");
  const from = isObject(m.from) && typeof m.from.id === "string" && SCOPED_ID.test(m.from.id) ? m.from.id : undefined;
  if (!from) problems.push("message has no sender that reads");
  const outbound = from === ctx.businessId;
  // The customer is who wrote an incoming message, or who an outgoing one went to.
  const to = isObject(m.to) && Array.isArray(m.to.data) ? m.to.data : [];
  const customers = outbound ? to.map((r) => (isObject(r) ? r.id : undefined)) : [from];
  const ids = customers.filter((c): c is string => typeof c === "string" && SCOPED_ID.test(c) && c !== ctx.businessId).slice(0, MAX_CUSTOMERS);
  if (from && outbound && ids.length === 0) problems.push("outgoing message has no recipient that reads");
  const attachments = isObject(m.attachments) && Array.isArray(m.attachments.data) ? m.attachments.data.length : Array.isArray(m.attachments) ? m.attachments.length : 0;
  const messageRef = id ? ctx.refs.node(ctx.channel, "message", id) : undefined;
  const payload = defined({
    system: SYSTEMS[ctx.channel],
    channel: ctx.channel,
    messageId: messageRef,
    conversationId: ctx.conversationRef,
    customerRefs: [...new Set(ids.map((c) => ctx.refs.person(ctx.channel, c)))].sort(),
    storeAccountId: ctx.businessId,
    direction: outbound ? "outbound" : "inbound",
    status: outbound ? "sent" : "received",
    attachmentCount: attachments,
    // How long, not what: enough to tell a quick reply from a long one.
    textLength: typeof m.message === "string" ? m.message.length : 0,
    unsupported: m.is_unsupported === true,
    sentAt,
  });
  return read(ctx.channel, raw, problems, messageRef, sentAt, payload, ctx.receivedAt);
}

/** A conversation the list gave that can't be read: no id or no updated time. Dead-lettered, as it can't be followed. */
export function metaConversationProblem(raw: unknown, channel: MetaPlatform, receivedAt: string): MetaEvent {
  const c = isObject(raw) ? raw : {};
  const problems = [
    ...(isObject(raw) ? [] : ["conversation is not an object"]),
    ...(typeof c.id === "string" && META_NODE_ID.test(c.id) ? [] : ["conversation has no id that reads"]),
    ...(metaTime(c.updated_time) ? [] : ["conversation has no updated time that reads"]),
  ];
  const key = `meta:${channel}:unreadable_conversation:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: META_MESSAGE_EVENT, occurredAt: undefined, receivedAt, idempotencyKey: key, payload: { system: SYSTEMS[channel], channel, conversationId: null, problems } };
}

/** A message id the conversation listed that couldn't be read, such as one Meta says was deleted. Dead-lettered. */
export function metaMessageProblem(channel: MetaPlatform, messageRef: string, problem: string, receivedAt: string): MetaEvent {
  const key = `meta:${channel}:unreadable_message:${short(messageRef)}`;
  return { id: key.replace(/:/g, "_"), type: META_MESSAGE_EVENT, occurredAt: undefined, receivedAt, idempotencyKey: key, payload: { system: SYSTEMS[channel], channel, messageId: messageRef, problems: [problem] } };
}

export interface WhatsAppContext {
  /** The store's phone number id; changes for any other number are left out. */
  phoneNumberId: string;
  refs: MetaRefs;
  receivedAt: string;
}

const WAMID = /^[A-Za-z0-9][A-Za-z0-9_.:=+/-]{0,255}$/;
const WA_TYPE = /^[a-z_]{1,32}$/;
export const WHATSAPP_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** A message a customer sent to the store's WhatsApp number. */
export function whatsappMessageEvent(raw: unknown, ctx: WhatsAppContext): MetaRead {
  const problems: string[] = [];
  const m = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("message is not an object");
  const id = typeof m.id === "string" && WAMID.test(m.id) ? m.id : undefined;
  if (!id) problems.push("message has no id that reads");
  const sentAt = whatsappTime(m.timestamp);
  if (!sentAt) problems.push("message has no timestamp that reads");
  const type = typeof m.type === "string" && WA_TYPE.test(m.type) ? m.type : undefined;
  if (!type) problems.push("message has no type that reads");
  const body = isObject(m.text) ? m.text.body : undefined;
  const messageRef = id ? ctx.refs.node("whatsapp", "message", id) : undefined;
  const payload = defined({
    system: SYSTEMS.whatsapp,
    channel: "whatsapp",
    messageId: messageRef,
    customerRefs: ctx.refs.phone(m.from),
    storeAccountId: ctx.phoneNumberId,
    direction: "inbound",
    status: "received",
    messageType: type,
    textLength: typeof body === "string" ? body.length : 0,
    sentAt,
  });
  return read("whatsapp", raw, problems, messageRef, sentAt, payload, ctx.receivedAt);
}

/** A status (sent, delivered, read, failed) for a message the store sent from its WhatsApp number. */
export function whatsappStatusEvent(raw: unknown, ctx: WhatsAppContext): MetaRead {
  const problems: string[] = [];
  const s = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("status is not an object");
  const id = typeof s.id === "string" && WAMID.test(s.id) ? s.id : undefined;
  if (!id) problems.push("status has no message id that reads");
  const at = whatsappTime(s.timestamp);
  if (!at) problems.push("status has no timestamp that reads");
  const status = typeof s.status === "string" && WHATSAPP_STATUSES.has(s.status) ? s.status : undefined;
  if (!status) problems.push("status is not sent, delivered, read or failed");
  const conversation = isObject(s.conversation) && typeof s.conversation.id === "string" && WAMID.test(s.conversation.id) ? s.conversation.id : undefined;
  const messageRef = id ? ctx.refs.node("whatsapp", "message", id) : undefined;
  const payload = defined({
    system: SYSTEMS.whatsapp,
    channel: "whatsapp",
    messageId: messageRef,
    conversationId: conversation ? ctx.refs.node("whatsapp", "conversation", conversation) : undefined,
    customerRefs: ctx.refs.phone(s.recipient_id),
    storeAccountId: ctx.phoneNumberId,
    direction: "outbound",
    status,
    statusAt: at,
  });
  return read("whatsapp", raw, problems, messageRef, at, payload, ctx.receivedAt);
}
