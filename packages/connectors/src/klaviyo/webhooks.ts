import { createHmac, timingSafeEqual } from "node:crypto";
import { klaviyoProfileRef } from "./customer.js";
import { klaviyoTime, KLAVIYO_EVENTS, type KlaviyoBrainEvent, type KlaviyoContext } from "./normalize.js";

/**
 * Klaviyo system webhooks. Klaviyo only lets Advanced KDP customers and
 * Klaviyo app partners create them (through the Webhooks API), so most
 * accounts won't have them; the scheduled sync reads everything without
 * them.
 *
 * A delivery carries `Klaviyo-Signature`, the hex HMAC-SHA256 keyed with the
 * webhook's secret over the raw body followed directly by the
 * `Klaviyo-Timestamp` header, plus `Klaviyo-Webhook-Id`, which must match
 * the body's `meta.klaviyo_webhook_id`. The signature is checked in
 * constant time, a timestamp more than five minutes off is refused so a
 * captured delivery can't be replayed later, and each event's
 * `external_id` is handled once (KlaviyoReplayGuard) and keyed, so a
 * redelivery is a duplicate.
 *
 * A delivery holds up to 1,000 events from any topics. Only email and SMS
 * consent changes become events; opens, clicks and the rest are per-person
 * activity, and the connector keeps campaign and flow figures in aggregate
 * only, so they are dropped.
 */

export type KlaviyoSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" | "wrong_webhook" };

export interface KlaviyoWebhookHeaders {
  signature: string | undefined;
  timestamp: string | undefined;
  webhookId: string | undefined;
}

/** How far a delivery's timestamp may be from now. */
export const KLAVIYO_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

const SIGNATURE = /^[0-9a-f]{64}$/i;
const WEBHOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reads Klaviyo-Timestamp. The docs show an HTTP date ("Thu, 04 Jan 2024
 * 18:05:25 GMT"); ISO times and Unix seconds are read too, as the docs don't
 * define the format.
 */
export function klaviyoWebhookTime(value: string): number {
  if (/^\d{9,10}$/.test(value)) return Number(value) * 1000;
  return Date.parse(value);
}

/**
 * Checks a delivery before its body is parsed: the signature, the timestamp
 * and the webhook id the body names. `rawBody` must be the bytes as received.
 */
export function verifyKlaviyoWebhook(secret: string, rawBody: string | Buffer, headers: KlaviyoWebhookHeaders, nowMs: number = Date.now()): KlaviyoSignatureCheck {
  const { signature, timestamp, webhookId } = headers;
  if (!secret || !signature || !timestamp || !webhookId) return { ok: false, reason: "missing" };
  if (signature.length > 100 || timestamp.length > 64 || webhookId.length > 64) return { ok: false, reason: "malformed" };
  const sig = signature.trim();
  if (!SIGNATURE.test(sig) || !WEBHOOK_ID.test(webhookId.trim())) return { ok: false, reason: "malformed" };
  const sent = klaviyoWebhookTime(timestamp.trim());
  if (Number.isNaN(sent)) return { ok: false, reason: "malformed" };
  if (Math.abs(nowMs - sent) > KLAVIYO_WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "stale" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(body).update(timestamp, "utf8").digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
  // Klaviyo says a body naming another webhook than the header means tampering.
  let named: unknown;
  try {
    named = (JSON.parse(body.toString("utf8")) as { meta?: { klaviyo_webhook_id?: unknown } } | null)?.meta?.klaviyo_webhook_id;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return named === webhookId.trim() ? { ok: true } : { ok: false, reason: "wrong_webhook" };
}

/** Klaviyo retries a failed delivery with backoff for up to about two days; event ids are remembered a little longer. */
export const KLAVIYO_REPLAY_WINDOW_MS = 50 * 3_600_000;

/**
 * Remembers recent event ids so a redelivered event is handled once. In
 * memory only: the event keys stop a replay from storing anything twice even
 * after a restart.
 */
export class KlaviyoReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(options: { windowMs?: number; maxEntries?: number; clock?: () => number } = {}) {
    this.windowMs = options.windowMs ?? KLAVIYO_REPLAY_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** True the first time an event id is seen within the window; false for a replay. */
  firstDelivery(eventId: string): boolean {
    const now = this.clock();
    // Insertion order is arrival order, so expired ids are always at the front.
    for (const [id, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(id);
    }
    if (this.seen.has(eventId)) return false;
    for (const id of this.seen.keys()) {
      if (this.seen.size < this.maxEntries) break;
      this.seen.delete(id);
    }
    this.seen.set(eventId, now);
    return true;
  }
}

/** Topics that change a profile's consent, and what each means. */
export const KLAVIYO_CONSENT_TOPICS: Record<string, { channel: "email" | "sms"; consent: "subscribed" | "unsubscribed" | "suppressed" | "unsuppressed" }> = {
  "event:klaviyo.subscribed_to_email_marketing": { channel: "email", consent: "subscribed" },
  "event:klaviyo.unsubscribed_from_email_marketing": { channel: "email", consent: "unsubscribed" },
  "event:klaviyo.manually_suppressed_from_email_marketing": { channel: "email", consent: "suppressed" },
  "event:klaviyo.manually_unsuppressed_from_email_marketing": { channel: "email", consent: "unsuppressed" },
  "event:klaviyo.subscribed_to_sms_marketing": { channel: "sms", consent: "subscribed" },
  "event:klaviyo.unsubscribed_from_sms_marketing": { channel: "sms", consent: "unsubscribed" },
};

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface DeliveryItem {
  external_id?: unknown;
  topic?: unknown;
  payload?: { data?: { id?: unknown; attributes?: { datetime?: unknown }; relationships?: { profile?: { data?: { id?: unknown } } } } };
}

/** The ids of a verified delivery's events, for the replay guard. */
export function klaviyoWebhookEventIds(body: unknown): string[] {
  const items = (body as { data?: unknown } | null)?.data;
  return Array.isArray(items) ? items.flatMap((i: DeliveryItem) => (typeof i?.external_id === "string" && EVENT_ID.test(i.external_id) ? [i.external_id] : [])) : [];
}

/**
 * Events for one verified delivery: a `marketing.consent_changed` for each
 * consent topic, under the profile reference the sync uses. Other topics,
 * and items without an id, a profile or a time, give none. `firstDelivery`,
 * when given, drops events a replay guard has seen.
 */
export function klaviyoWebhookEvents(body: unknown, ctx: KlaviyoContext, firstDelivery?: (eventId: string) => boolean): KlaviyoBrainEvent[] {
  const items = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 1000).flatMap((item: DeliveryItem) => {
    const eventId = typeof item?.external_id === "string" && EVENT_ID.test(item.external_id) ? item.external_id : undefined;
    const topic = typeof item?.topic === "string" && Object.hasOwn(KLAVIYO_CONSENT_TOPICS, item.topic) ? KLAVIYO_CONSENT_TOPICS[item.topic] : undefined;
    if (!eventId || !topic) return [];
    const profileRef = klaviyoProfileRef(ctx.customerKey, item.payload?.data?.relationships?.profile?.data?.id);
    const at = klaviyoTime(item.payload?.data?.attributes?.datetime);
    if (!profileRef || !at) return [];
    if (firstDelivery && !firstDelivery(eventId)) return [];
    return [
      {
        id: `klaviyo_consent_${eventId}`,
        type: KLAVIYO_EVENTS.consent,
        occurredAt: at,
        receivedAt: ctx.receivedAt,
        idempotencyKey: `klaviyo:consent:${eventId}`,
        payload: { profileRef, channel: topic.channel, consent: topic.consent, changedAt: at },
      },
    ];
  });
}
