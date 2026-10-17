import { createHmac, timingSafeEqual } from "node:crypto";
import { stripeObjectEvents, type StripeBrainEvent } from "./normalize.js";

/**
 * Stripe sends the same event objects to webhooks that the events API lists,
 * so a webhook and an incremental sync of the same change produce the same
 * events, and whichever arrives second is a duplicate.
 */

/** A Stripe event: what changed, and the object as it was after the change. */
export interface StripeEvent {
  id: string;
  object: "event";
  type: string;
  created: number;
  data: { object: { object?: string } };
}

/** The event types the connector reads; at most 20, Stripe's limit for one events query. */
export const STRIPE_EVENT_TYPES = [
  "charge.succeeded",
  "charge.failed",
  "charge.captured",
  "charge.refunded",
  "charge.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
  "customer.created",
  "customer.updated",
] as const;

const READ = new Set<string>(STRIPE_EVENT_TYPES);

/** Stripe's default tolerance: a signature more than 5 minutes old is a replay. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export type StripeSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" | "expired" };

/**
 * Checks `Stripe-Signature` (`t=<unix>,v1=<hex>[,v1=<hex>]`): HMAC-SHA256 of
 * `<t>.<raw body>` keyed with the endpoint's signing secret, within the
 * tolerance of `nowSeconds`. Check before parsing the body.
 */
export function verifyStripeWebhook(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
  nowSeconds: number,
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): StripeSignatureCheck {
  if (!secret || !header) return { ok: false, reason: "missing" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const timestamps = parts.filter(([k]) => k === "t").map(([, v]) => Number(v));
  const signatures = parts.filter(([k, v]) => k === "v1" && v && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => Buffer.from(v!, "hex"));
  const t = timestamps[0];
  if (timestamps.length !== 1 || !Number.isInteger(t) || signatures.length === 0) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest();
  if (!signatures.some((s) => s.length === expected.length && timingSafeEqual(s, expected))) return { ok: false, reason: "mismatch" };
  if (Math.abs(nowSeconds - t!) > toleranceSeconds) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** Events for one verified Stripe event. Types the connector doesn't read give none. */
export function stripeWebhookEvents(event: StripeEvent, receivedAt: string): StripeBrainEvent[] {
  if (!event || event.object !== "event" || !READ.has(event.type)) return [];
  return stripeObjectEvents(event.data?.object, receivedAt);
}
