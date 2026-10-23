import { createHmac, timingSafeEqual } from "node:crypto";
import { wooCustomerEvent, wooOrderEvents, wooProductEvents, wooTime, type WooCommerceBrainEvent, type WooCommerceContext, type WooRecord } from "./normalize.js";

/**
 * WooCommerce webhooks. Each delivery is a POST of the resource as the REST
 * API returns it, signed in `X-WC-Webhook-Signature`: the base64
 * HMAC-SHA256 of the raw body, keyed with the webhook's secret.
 *
 * WooCommerce signs no timestamp, so a captured delivery stays valid
 * forever. Replays are handled three ways:
 * - `WooCommerceReplayGuard` handles each `X-WC-Webhook-Delivery-ID` once;
 * - a delivery whose record was last modified more than a day ago gives no
 *   events (WooCommerce delivers within minutes and never retries; the
 *   scheduled sync reads anything older);
 * - the event keys are the sync's own, so a replay that gets through still
 *   stores nothing twice, even after a restart.
 *
 * Order and customer deliveries become events. A variable product's
 * delivery doesn't carry its variations, and deletions carry only an ID, so
 * those are a prompt to sync, not data.
 */

export type WooCommerceSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/** A base64 HMAC-SHA256: 43 characters and one pad. */
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Checks `X-WC-Webhook-Signature` against the raw body, in constant time.
 * Check before parsing the body. WooCommerce decodes HTML entities in the
 * secret before signing, so use a secret of letters and digits only.
 */
export function verifyWooCommerceWebhook(secret: string, rawBody: string | Buffer, header: string | undefined): WooCommerceSignatureCheck {
  if (!secret || !header) return { ok: false, reason: "missing" };
  if (header.length > 100) return { ok: false, reason: "malformed" };
  const value = header.trim();
  if (!SIGNATURE.test(value)) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(value, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** WooCommerce's delivery IDs are hashes; anything else is refused. */
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const wooCommerceDeliveryId = (header: string | undefined): string | undefined =>
  typeof header === "string" && header.length <= 64 && DELIVERY_ID.test(header) ? header : undefined;

/** Delivery IDs are remembered this long. */
export const WOOCOMMERCE_REPLAY_WINDOW_MS = 25 * 3_600_000;
/** A delivery whose record changed longer ago than this gives no events; the sync reads it instead. */
export const WOOCOMMERCE_STALE_DELIVERY_MS = 24 * 3_600_000;

/**
 * Remembers recent delivery IDs so a replayed delivery is handled once. In
 * memory only: the event keys stop a replay from storing anything twice
 * even after a restart.
 */
export class WooCommerceReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(options: { windowMs?: number; maxEntries?: number; clock?: () => number } = {}) {
    this.windowMs = options.windowMs ?? WOOCOMMERCE_REPLAY_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** True the first time a delivery ID is seen within the window; false for a replay or an unreadable ID. */
  firstDelivery(header: string | undefined): boolean {
    const id = wooCommerceDeliveryId(header);
    if (!id) return false;
    const now = this.clock();
    // Insertion order is arrival order, so expired IDs are always at the front.
    for (const [seenId, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(seenId);
    }
    if (this.seen.has(id)) return false;
    for (const oldest of this.seen.keys()) {
      if (this.seen.size < this.maxEntries) break;
      this.seen.delete(oldest);
    }
    this.seen.set(id, now);
    return true;
  }
}

/** A verified delivery: the `X-WC-Webhook-Topic` header and the parsed body. */
export interface WooCommerceWebhookDelivery {
  topic: string;
  payload: unknown;
}

/** Topics whose delivery carries a record the connector keeps. */
export const WOOCOMMERCE_WEBHOOK_DATA_TOPICS = ["order.created", "order.updated", "product.created", "product.updated", "customer.created", "customer.updated"] as const;
/** Topics that only say something changed or went; the next sync reads it. */
export const WOOCOMMERCE_WEBHOOK_PROMPT_TYPES = ["order.deleted", "order.restored", "product.deleted", "product.restored", "customer.deleted"] as const;

/**
 * Events for one verified delivery. A stale delivery, an unknown topic, a
 * ping (whose body isn't a record) or a variable product gives none.
 */
export function wooCommerceWebhookEvents(delivery: WooCommerceWebhookDelivery, ctx: WooCommerceContext, now: Date): WooCommerceBrainEvent[] {
  const topic = typeof delivery?.topic === "string" && delivery.topic.length <= 40 ? delivery.topic : "";
  if (!(WOOCOMMERCE_WEBHOOK_DATA_TOPICS as readonly string[]).includes(topic)) return [];
  const record = delivery.payload;
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const r = record as WooRecord;
  const changed = wooTime(r.date_modified_gmt) ?? wooTime(r.date_created_gmt);
  if (!changed || now.getTime() - Date.parse(changed) > WOOCOMMERCE_STALE_DELIVERY_MS) return [];
  if (topic.startsWith("order.")) return wooOrderEvents(r, ctx);
  if (topic.startsWith("customer.")) {
    const made = wooCustomerEvent(r, ctx);
    return made ? [made] : [];
  }
  return r.type === "variable" ? [] : wooProductEvents(r, null, ctx);
}
