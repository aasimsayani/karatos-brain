import { createHmac, timingSafeEqual } from "node:crypto";
import { squareCustomerEvent, squarePaymentEvent, squareRefundEvent, type SquareBrainEvent, type SquareContext, type SquareRecord } from "./normalize.js";

/**
 * Square webhooks. A delivery is signed with the subscription's signature
 * key over the notification URL followed by the raw body. Square signs no
 * timestamp, so a captured delivery stays valid forever: replays are caught
 * by the notification's event_id (SquareReplayGuard) and, durably, by the
 * event keys, which are the same ones the sync uses, so a redelivery or a
 * webhook for a record the sync already read is a duplicate.
 *
 * Payment, refund and customer notifications carry the record and become
 * events. Order, inventory and catalog notifications only name what changed,
 * so they are a prompt to sync, not data.
 */

export type SquareSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/** A base64 HMAC-SHA256: 43 characters and one pad. */
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Checks `x-square-hmacsha256-signature`: base64 HMAC-SHA256, keyed with the
 * subscription's signature key, of the notification URL exactly as set on
 * the subscription followed by the raw body. Check before parsing the body.
 */
export function verifySquareWebhook(signatureKey: string, notificationUrl: string, rawBody: string | Buffer, header: string | undefined): SquareSignatureCheck {
  if (!signatureKey || !notificationUrl || !header) return { ok: false, reason: "missing" };
  if (header.length > 100) return { ok: false, reason: "malformed" };
  const value = header.trim();
  if (!SIGNATURE.test(value)) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", signatureKey).update(Buffer.from(notificationUrl, "utf8")).update(body).digest();
  const given = Buffer.from(value, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface SquareNotification {
  eventId: string;
  type: string;
  merchantId: string | undefined;
  /** The changed record's object type and ID, as Square names them in `data`. */
  objectType: string | undefined;
  objectId: string | undefined;
  object: SquareRecord | undefined;
}

const EVENT_ID = /^[A-Za-z0-9-]+$/;
const TYPE = /^[a-z_]+(\.[a-z_]+){1,3}$/;
const OBJECT_ID = /^[A-Za-z0-9_-]+$/;
const short = (value: unknown, max: number, pattern: RegExp) => (typeof value === "string" && value.length > 0 && value.length <= max && pattern.test(value) ? value : undefined);

/** The parts of a verified notification the connector uses. Null for anything not shaped like one. */
export function squareNotification(body: unknown): SquareNotification | null {
  const b = body as { event_id?: unknown; type?: unknown; merchant_id?: unknown; data?: { type?: unknown; id?: unknown; object?: unknown } } | null;
  if (!b || typeof b !== "object") return null;
  const eventId = short(b.event_id, 64, EVENT_ID);
  const type = short(b.type, 60, TYPE);
  if (!eventId || !type) return null;
  const object = b.data?.object;
  return {
    eventId,
    type,
    merchantId: short(b.merchant_id, 191, OBJECT_ID),
    objectType: short(b.data?.type, 40, /^[a-z_]+$/),
    objectId: short(b.data?.id, 192, OBJECT_ID),
    object: object && typeof object === "object" && !Array.isArray(object) ? (object as SquareRecord) : undefined,
  };
}

/** Square retries a delivery for up to 24 hours; event IDs are remembered a little longer. */
export const SQUARE_REPLAY_WINDOW_MS = 25 * 3_600_000;

/**
 * Remembers recent event IDs so a redelivered or replayed notification is
 * handled once. In memory only: the event keys stop a replay from storing
 * anything twice even after a restart.
 */
export class SquareReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(options: { windowMs?: number; maxEntries?: number; clock?: () => number } = {}) {
    this.windowMs = options.windowMs ?? SQUARE_REPLAY_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** True the first time an event ID is seen within the window; false for a replay. */
  firstDelivery(eventId: string): boolean {
    const now = this.clock();
    // Insertion order is arrival order, so expired IDs are always at the front.
    for (const [id, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(id);
    }
    if (this.seen.has(eventId)) return false;
    // Full: forget the oldest, which Square has the longest since stopped retrying.
    for (const id of this.seen.keys()) {
      if (this.seen.size < this.maxEntries) break;
      this.seen.delete(id);
    }
    this.seen.set(eventId, now);
    return true;
  }
}

/** Notification types that carry a record the connector keeps. */
export const SQUARE_WEBHOOK_DATA_TYPES = ["payment.created", "payment.updated", "refund.created", "refund.updated", "customer.created", "customer.updated"] as const;
/** Notification types that only say something changed; the next sync reads it. */
export const SQUARE_WEBHOOK_PROMPT_TYPES = ["order.created", "order.updated", "order.fulfillment.updated", "inventory.count.updated", "catalog.version.updated"] as const;

/**
 * Events for one verified notification. Notifications for another merchant,
 * of types the connector doesn't read, or without their record give none.
 */
export function squareWebhookEvents(body: unknown, ctx: SquareContext, merchantId?: string): SquareBrainEvent[] {
  const n = squareNotification(body);
  if (!n || !n.object || (merchantId !== undefined && n.merchantId !== merchantId)) return [];
  if (!(SQUARE_WEBHOOK_DATA_TYPES as readonly string[]).includes(n.type)) return [];
  const record = n.object[n.objectType ?? ""] as SquareRecord | undefined;
  if (!record || typeof record !== "object") return [];
  const made = n.type.startsWith("payment.") ? squarePaymentEvent(record, ctx) : n.type.startsWith("refund.") ? squareRefundEvent(record, ctx) : squareCustomerEvent(record, ctx);
  return made ? [made] : [];
}
