import { createHash, timingSafeEqual } from "node:crypto";

/**
 * BigCommerce webhooks. A notification names what changed (a scope such as
 * `store/order/updated` and the record's ID) without the record, so it is a
 * prompt to sync, not data: the next incremental pass reads the change.
 *
 * Webhooks created with a store-level API account carry no signature.
 * BigCommerce sends any custom headers set when the webhook is created, so
 * the webhook is created with a shared secret in BIGCOMMERCE_WEBHOOK_HEADER,
 * which is compared here in constant time. Because a captured delivery could
 * be sent again, notifications older than BigCommerce's 48-hour retry window
 * are dropped, and one already seen (by its `hash`, which BigCommerce keeps
 * the same across deliveries of one event) is a duplicate.
 */

/** The custom header the webhook is created with, carrying BIGCOMMERCE_WEBHOOK_SECRET. */
export const BIGCOMMERCE_WEBHOOK_HEADER = "x-karatos-webhook-secret";

export type BigCommerceSecretCheck = { ok: true } | { ok: false; reason: "missing" | "mismatch" };

const MAX_HEADER = 256;
const MIN_SECRET = 32;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Checks the shared secret header against BIGCOMMERCE_WEBHOOK_SECRET, in
 * constant time: both are hashed first, so neither their content nor their
 * length leaks. Check before parsing the body; anything but ok is answered 401.
 */
export function verifyBigCommerceWebhook(secret: string, header: string | undefined | null): BigCommerceSecretCheck {
  const expected = secret?.trim() ?? "";
  if (expected.length < MIN_SECRET || typeof header !== "string" || !header.trim() || header.length > MAX_HEADER) return { ok: false, reason: "missing" };
  return timingSafeEqual(digest(header.trim()), digest(expected)) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The scopes the connector reads, by the stream a prompted sync picks them up in. */
export const BIGCOMMERCE_WEBHOOK_SCOPES = {
  "store/order/created": "orders",
  "store/order/updated": "orders",
  "store/order/statusUpdated": "orders",
  "store/order/refund/created": "orders",
  "store/product/created": "products",
  "store/product/updated": "products",
  "store/product/inventory/updated": "inventory",
  "store/sku/inventory/updated": "inventory",
  "store/customer/created": "customers",
  "store/customer/updated": "customers",
  "store/priceList/created": "price_lists",
  "store/priceList/updated": "price_lists",
  "store/priceList/activated": "price_lists",
  "store/priceList/deactivated": "price_lists",
  "store/priceList/record/created": "price_list_records",
  "store/priceList/record/updated": "price_list_records",
  "store/priceList/records/created": "price_list_records",
  "store/priceList/records/updated": "price_list_records",
} as const;
export type BigCommerceWebhookStream = (typeof BIGCOMMERCE_WEBHOOK_SCOPES)[keyof typeof BIGCOMMERCE_WEBHOOK_SCOPES];

export interface BigCommerceChange {
  scope: keyof typeof BIGCOMMERCE_WEBHOOK_SCOPES;
  stream: BigCommerceWebhookStream;
  /** The changed record's ID, when the notification names one. */
  id: string | undefined;
  /** BigCommerce's hash of the event, the same on every delivery of it. */
  hash: string;
  /** When BigCommerce sent it, Unix seconds. */
  createdAt: number;
}

export interface BigCommerceWebhookOptions {
  /** The store this instance syncs; notifications for another store are dropped. */
  storeHash: string;
  /** Milliseconds since the epoch. */
  now: number;
  /** How old a notification may be. 49 hours by default, just past BigCommerce's 48 hours of retries. */
  replayWindowMs?: number;
}

export const BIGCOMMERCE_REPLAY_WINDOW_MS = 49 * 3_600_000;
/** Clock skew allowed for a notification stamped in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;
const HASH = /^[0-9a-f]{40}$/;

/**
 * The change a verified notification names, for this store and inside the
 * replay window. Null for scopes the connector doesn't read and anything not
 * shaped like BigCommerce's notification.
 */
export function bigCommerceWebhookChange(body: unknown, options: BigCommerceWebhookOptions): BigCommerceChange | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as { scope?: unknown; producer?: unknown; hash?: unknown; created_at?: unknown; data?: { id?: unknown } };
  if (b.producer !== `stores/${options.storeHash}`) return null;
  const scope = typeof b.scope === "string" && Object.hasOwn(BIGCOMMERCE_WEBHOOK_SCOPES, b.scope) ? (b.scope as BigCommerceChange["scope"]) : undefined;
  if (!scope) return null;
  if (typeof b.hash !== "string" || b.hash.length !== 40 || !HASH.test(b.hash)) return null;
  const created = b.created_at;
  const window = options.replayWindowMs ?? BIGCOMMERCE_REPLAY_WINDOW_MS;
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created * 1000 < options.now - window || created * 1000 > options.now + FUTURE_SKEW_MS) return null;
  const rawId = b.data?.id;
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : undefined;
  return { scope, stream: BIGCOMMERCE_WEBHOOK_SCOPES[scope], id, hash: b.hash, createdAt: created };
}

/**
 * Remembers the notifications already taken, by hash, so a redelivery or a
 * replay inside the window is a duplicate. Bounded: the oldest are forgotten
 * first, and anything older than the window is dropped by
 * bigCommerceWebhookChange anyway.
 */
export class BigCommerceWebhookDeduper {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(options: { windowMs?: number; maxEntries?: number } = {}) {
    this.windowMs = options.windowMs ?? BIGCOMMERCE_REPLAY_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** True the first time a change's hash is seen within the window; false for a duplicate. */
  first(change: BigCommerceChange, now: number): boolean {
    // Insertion order is arrival order, so expired hashes are always at the front.
    for (const [hash, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(hash);
    }
    if (this.seen.has(change.hash)) return false;
    for (const hash of this.seen.keys()) {
      if (this.seen.size < this.maxEntries) break;
      this.seen.delete(hash);
    }
    this.seen.set(change.hash, now);
    return true;
  }
}
