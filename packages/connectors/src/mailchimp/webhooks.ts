import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Mailchimp audience webhooks. Mailchimp doesn't sign deliveries, so the
 * only proof one came from Mailchimp is a secret the instance put in the
 * webhook URL when registering it (`?key=<MAILCHIMP_WEBHOOK_SECRET>`).
 * A delivery is a prompt to sync the audience, not data: it carries the
 * member's email address and merge fields, which are never kept.
 */

export type MailchimpWebhookCheck = { ok: true } | { ok: false; reason: "missing" | "mismatch" };

const MIN_SECRET_LENGTH = 32;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Checks the `key` query parameter of a delivery's URL against the secret,
 * in constant time (both are hashed first, so their lengths don't leak).
 * Anything but ok must be answered 401. Mailchimp also sends a GET to the
 * URL when the webhook is created; answer that 200 only when this passes.
 */
export function verifyMailchimpWebhook(secret: string, url: string | URL): MailchimpWebhookCheck {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: "missing" };
  let given: string | null;
  try {
    given = new URL(url, "https://webhook.invalid").searchParams.get("key");
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!given) return { ok: false, reason: "missing" };
  return timingSafeEqual(sha(given), sha(secret)) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export const MAILCHIMP_WEBHOOK_TYPES = ["subscribe", "unsubscribe", "profile", "upemail", "cleaned", "campaign"] as const;
export type MailchimpWebhookType = (typeof MAILCHIMP_WEBHOOK_TYPES)[number];

export interface MailchimpWebhookEvent {
  type: MailchimpWebhookType;
  listId: string;
  /** ISO time Mailchimp fired it. */
  time: string | undefined;
}

const LIST_ID = /^[A-Za-z0-9]{1,32}$/;

/**
 * What a verified delivery is about, from its form-encoded body: its type,
 * audience and time, and nothing about the member. A delivery for an
 * audience not in `listIds` (when given), or not shaped like one, is null.
 */
export function mailchimpWebhookEvent(body: string, listIds?: readonly string[]): MailchimpWebhookEvent | null {
  if (typeof body !== "string" || body.length > 64_000) return null;
  const form = new URLSearchParams(body);
  const type = MAILCHIMP_WEBHOOK_TYPES.find((t) => t === form.get("type"));
  const listId = form.get("data[list_id]") ?? "";
  if (!type || !LIST_ID.test(listId) || (listIds && !listIds.includes(listId))) return null;
  // Mailchimp writes fired_at as "YYYY-MM-DD HH:MM:SS" in UTC.
  const fired = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(form.get("fired_at") ?? "") ? Date.parse(`${form.get("fired_at")!.replace(" ", "T")}Z`) : Number.NaN;
  return { type, listId, time: Number.isNaN(fired) ? undefined : new Date(fired).toISOString() };
}
