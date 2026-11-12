import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { whatsappMessageEvent, whatsappStatusEvent, type MetaEvent, type WhatsAppContext } from "./normalize.js";

/**
 * Meta webhooks. WhatsApp Business has no API that reads message history:
 * messages and delivery statuses arrive only by webhook, so WhatsApp is
 * webhook-only, with no historical import. Each delivery for the store's
 * own phone number becomes the event a synced message would be, keyed the
 * same way, so a delivery Meta sends again is a duplicate.
 *
 * Messenger and Instagram webhooks are signed the same way, but the docs
 * this connector was built from don't describe their bodies, so a verified
 * one is a prompt to sync, not data: the next incremental pass reads the
 * conversation.
 *
 * Every delivery is a POST signed in `X-Hub-Signature-256: sha256=<hex>`,
 * the HMAC-SHA256 of the raw body keyed with the app secret. Meta first
 * checks the endpoint with a GET carrying hub.mode=subscribe, hub.challenge
 * and hub.verify_token, answered 200 with the challenge only when the
 * verify token matches.
 *
 * Meta retries a delivery "immediately, then a few more times with
 * decreasing frequency" for 7 days, then drops it, and batches up to 1000
 * updates; the receiver must dedupe. A delivery carries no signed time, so
 * a replay inside those 7 days can't be told from a retry: changes are
 * deduplicated by event key, and anything stamped older than 7 days (or
 * more than 5 minutes ahead) is left out.
 */

export type MetaSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/** The header Meta signs deliveries in. */
export const META_SIGNATURE_HEADER = "x-hub-signature-256";
/** How long Meta retries a delivery; anything older is a replay. */
export const META_WEBHOOK_RETRY_WINDOW_MS = 7 * 86_400_000;
/** Clock skew allowed for a change stamped in the future. */
export const META_WEBHOOK_FUTURE_SKEW_MS = 5 * 60_000;
/** The most updates Meta batches into one delivery. */
export const META_WEBHOOK_MAX_UPDATES = 1000;

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks X-Hub-Signature-256 against the HMAC-SHA256 of the raw body keyed
 * with META_APP_SECRET, in constant time. Check before parsing the body, and
 * answer anything but ok with a 401.
 */
export function verifyMetaWebhook(appSecret: string, rawBody: string | Buffer, header: string | undefined | null): MetaSignatureCheck {
  if (!appSecret?.trim() || typeof header !== "string" || !header.trim()) return { ok: false, reason: "missing" };
  const m = SIGNATURE.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", appSecret.trim()).update(body).digest();
  return timingSafeEqual(Buffer.from(m[1]!, "hex"), expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The verification GET's query, as URLSearchParams or a plain map of its values. */
export type MetaChallengeQuery = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

const one = (query: MetaChallengeQuery, name: string): string | undefined => {
  if (query instanceof URLSearchParams) return query.getAll(name).length === 1 ? query.get(name)! : undefined;
  const v = Object.hasOwn(query, name) ? query[name] : undefined;
  return typeof v === "string" ? v : undefined;
};

/**
 * The challenge to answer Meta's verification GET with (200, as plain
 * text), or null when it should be turned down with a 403: the mode isn't
 * subscribe, the verify token doesn't match WHATSAPP_VERIFY_TOKEN (compared
 * in constant time), or the challenge isn't a short run of plain characters.
 */
export function metaWebhookChallenge(verifyToken: string, query: MetaChallengeQuery): string | null {
  const expected = verifyToken?.trim() ?? "";
  const mode = one(query, "hub.mode");
  const given = one(query, "hub.verify_token");
  const challenge = one(query, "hub.challenge");
  if (!expected || mode !== "subscribe" || given === undefined || challenge === undefined) return null;
  if (!timingSafeEqual(digest(given), digest(expected))) return null;
  return /^[A-Za-z0-9_.-]{1,256}$/.test(challenge) ? challenge : null;
}

export interface WhatsAppWebhookOptions extends WhatsAppContext {
  /** Milliseconds since the epoch. */
  now: number;
}

/** When a WhatsApp message or status says it happened, in milliseconds, or null. */
const stamped = (event: MetaEvent): number | null => (event.occurredAt === undefined ? null : Date.parse(event.occurredAt));

/**
 * The events in one verified WhatsApp delivery: each message a customer
 * sent to the store's number and each status of a message the store sent.
 * Deliveries for another object, field, product or phone number, and
 * changes stamped outside the retry window, are left out; a change for the
 * store's number that doesn't read is dead-lettered.
 */
export function whatsappWebhookEvents(body: unknown, options: WhatsAppWebhookOptions): MetaEvent[] {
  if (!isObject(body) || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return [];
  const raws: { kind: "message" | "status"; raw: unknown }[] = [];
  for (const entry of body.entry) {
    for (const change of isObject(entry) && Array.isArray(entry.changes) ? entry.changes : []) {
      if (!isObject(change) || change.field !== "messages" || !isObject(change.value)) continue;
      const value = change.value;
      if (value.messaging_product !== "whatsapp" || !isObject(value.metadata) || value.metadata.phone_number_id !== options.phoneNumberId) continue;
      for (const raw of Array.isArray(value.messages) ? value.messages : []) raws.push({ kind: "message", raw });
      for (const raw of Array.isArray(value.statuses) ? value.statuses : []) raws.push({ kind: "status", raw });
    }
  }
  return raws.slice(0, META_WEBHOOK_MAX_UPDATES).flatMap(({ kind, raw }) => {
    const { event } = kind === "message" ? whatsappMessageEvent(raw, options) : whatsappStatusEvent(raw, options);
    const at = stamped(event);
    if (at !== null && (at < options.now - META_WEBHOOK_RETRY_WINDOW_MS || at > options.now + META_WEBHOOK_FUTURE_SKEW_MS)) return [];
    return [event];
  });
}

/**
 * Remembers the events already taken, by event key, so a delivery Meta
 * sends again (or one replayed) is a duplicate. Bounded: the oldest are
 * forgotten first; anything older than the retry window is left out by
 * whatsappWebhookEvents anyway, and the pipeline dedupes by the same key.
 */
export class MetaWebhookDeduper {
  private readonly seen = new Set<string>();

  constructor(private readonly max = 10_000) {}

  /** The events not seen before, remembering them. */
  fresh(events: readonly MetaEvent[]): MetaEvent[] {
    const out: MetaEvent[] = [];
    for (const event of events) {
      if (this.seen.has(event.idempotencyKey)) continue;
      this.seen.add(event.idempotencyKey);
      out.push(event);
      if (this.seen.size > this.max) this.seen.delete(this.seen.values().next().value!);
    }
    return out;
  }
}
