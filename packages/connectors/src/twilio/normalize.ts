import { createHmac } from "node:crypto";
import type { TwilioCall, TwilioMessage } from "./client.js";

/**
 * Turns Twilio messages and calls into Brain A events:
 * communication.message_logged for each status a text reaches, and
 * communication.call_logged for each status a call reaches. Only what the
 * store needs to see how fast it answers customers is kept:
 *
 * - Message bodies are never read into an event, and neither are media
 *   links or error messages (which can quote the body).
 * - The customer's number becomes a contact reference, an HMAC-SHA256 under
 *   TWILIO_CONTACT_KEY, so the same customer lines up across texts and
 *   calls without the number being kept.
 * - The store's own line is kept as its last four digits, enough to tell
 *   two lines apart.
 */

export interface TwilioEvent {
  id: string;
  type: "communication.message_logged" | "communication.call_logged";
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const MIN_CONTACT_KEY_LENGTH = 32;

export class TwilioContactKeyError extends Error {
  constructor() {
    super(`TWILIO_CONTACT_KEY must be at least ${MIN_CONTACT_KEY_LENGTH} characters; let npm run secrets:setup generate it`);
    this.name = "TwilioContactKeyError";
  }
}

const SID = { message: /^(SM|MM)[0-9a-f]{32}$/, call: /^CA[0-9a-f]{32}$/ };

/** A channel address as Twilio writes it: "+12125550100", "whatsapp:+12125550100", "client:alice". */
export function channelOf(address: string | null | undefined): { channel: "phone" | "whatsapp" | "other"; number: string | null } {
  const a = (address ?? "").trim();
  const m = /^(whatsapp:)?(\+?\d[\d\s().-]{5,})$/.exec(a);
  if (m) return { channel: m[1] ? "whatsapp" : "phone", number: m[2]!.replace(/\D/g, "") };
  return { channel: "other", number: null };
}

/** The same customer always gets the same reference; the number itself isn't kept. */
export function contactRef(key: string, address: string | null | undefined): string | undefined {
  const a = (address ?? "").trim();
  if (!a) return undefined;
  const { number } = channelOf(a);
  return `twilio:contact:${createHmac("sha256", key).update(number ?? a.toLowerCase()).digest("hex").slice(0, 24)}`;
}

/** The store's line, as its last four digits, so lines can be told apart without keeping the number. */
export const storeLine = (address: string | null | undefined): string | undefined => {
  const { number } = channelOf(address);
  return number ? `…${number.slice(-4)}` : undefined;
};

/** RFC 2822 (what Twilio writes) to ISO. Undefined for anything else. */
export function twilioTime(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(value)) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** "-0.00750" → 7500 micro-units. Twilio writes charges as negative decimals; the cost is kept positive, without floating point. */
export function priceMicros(value: string | null | undefined): number | undefined {
  const m = typeof value === "string" ? /^-?(\d{1,6})(?:\.(\d{1,6}))?$/.exec(value.trim()) : null;
  if (!m) return undefined;
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

const count = (value: string | null | undefined) => (typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : undefined);
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const currency = (unit: string | null | undefined) => (typeof unit === "string" && /^[A-Za-z]{3}$/.test(unit) ? unit.toUpperCase() : undefined);

/** Who the customer is on a record: the far end of the line. */
const sides = (direction: string, from: string | null, to: string | null) => (direction === "inbound" ? { customer: from, store: to } : { customer: to, store: from });

const event = (kind: "message" | "call", sid: string, status: string, type: TwilioEvent["type"], occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): TwilioEvent => ({
  id: `twilio_${kind}_${sid}_${status.replace(/[^a-z-]/g, "_")}`,
  type,
  occurredAt,
  receivedAt,
  idempotencyKey: `twilio:${kind}:${sid}:${status}`,
  payload,
});

const STATUS = /^[a-z][a-z_-]{1,30}$/;

export function twilioNormalizer(key: string) {
  if (key.length < MIN_CONTACT_KEY_LENGTH) throw new TwilioContactKeyError();
  return {
    /** One event per status a message reaches; a record that isn't a Twilio message is skipped. */
    message(m: TwilioMessage, receivedAt: string): TwilioEvent[] {
      if (!m || !SID.message.test(m.sid) || typeof m.status !== "string" || !STATUS.test(m.status) || typeof m.direction !== "string") return [];
      const { customer, store } = sides(m.direction, m.from, m.to);
      const { channel } = channelOf(customer);
      const media = count(m.num_media);
      const sentAt = twilioTime(m.date_sent) ?? twilioTime(m.date_created);
      return [
        event("message", m.sid, m.status, "communication.message_logged", sentAt, receivedAt, defined({
          channel: channel === "whatsapp" ? "whatsapp" : media ? "mms" : channel === "phone" ? "sms" : "other",
          messageId: `twilio:message:${m.sid}`,
          contactRef: contactRef(key, customer),
          storeLine: storeLine(store),
          direction: m.direction === "inbound" ? "inbound" : "outbound",
          kind: m.direction,
          status: m.status,
          segments: count(m.num_segments),
          mediaCount: media,
          errorCode: typeof m.error_code === "number" ? m.error_code : undefined,
          costMicros: priceMicros(m.price),
          currency: currency(m.price_unit),
          sentAt,
        })),
      ];
    },

    /** One event per status a call reaches. */
    call(c: TwilioCall, receivedAt: string): TwilioEvent[] {
      if (!c || !SID.call.test(c.sid) || typeof c.status !== "string" || !STATUS.test(c.status) || typeof c.direction !== "string") return [];
      const { customer, store } = sides(c.direction, c.from, c.to);
      const inbound = c.direction === "inbound";
      const startedAt = twilioTime(c.start_time) ?? twilioTime(c.date_created);
      return [
        event("call", c.sid, c.status, "communication.call_logged", startedAt, receivedAt, defined({
          channel: "voice",
          callId: `twilio:call:${c.sid}`,
          contactRef: contactRef(key, customer),
          storeLine: storeLine(store),
          direction: inbound ? "inbound" : "outbound",
          kind: c.direction,
          status: c.status,
          // An inbound call nobody picked up: busy, not answered, or the caller hung up first.
          missed: inbound && ["busy", "no-answer", "canceled"].includes(c.status) ? true : undefined,
          durationSeconds: count(c.duration),
          costMicros: priceMicros(c.price),
          currency: currency(c.price_unit),
          startedAt,
          endedAt: twilioTime(c.end_time),
        })),
      ];
    },
  };
}
