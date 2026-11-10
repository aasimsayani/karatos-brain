import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Microsoft Graph change notifications for a drive. Making the subscription
 * is a write (a POST to /subscriptions), so KaratOS only declares it and an
 * admin makes it while writes are off. When Graph checks the notification
 * URL it sends `?validationToken=`, which must be echoed back as plain text
 * within ten seconds. After that each notification is a POST listing the
 * subscriptions that saw a change, each with the clientState the
 * subscription was made with; it carries no file data, so it is a prompt to
 * run the incremental sync, which reads the change itself. A replayed
 * notification only prompts a sync that finds nothing new.
 */

const CLIENT_STATE = /^[\x21-\x7e]{16,128}$/;
const VALIDATION_MAX = 1024;

/** The answer to Graph's check of the notification URL: the token echoed as plain text, or a 400. */
export function microsoftWebhookValidation(validationToken: string | null | undefined): { status: 200 | 400; body: string; headers: Record<string, string> } {
  const headers = { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" };
  const ok = typeof validationToken === "string" && validationToken.length > 0 && validationToken.length <= VALIDATION_MAX && !/[\u0000-\u001f\u007f<>]/.test(validationToken);
  return ok ? { status: 200, body: validationToken, headers } : { status: 400, body: "", headers };
}

/** Whether MICROSOFT_GRAPH_CLIENT_STATE reads as one: 16 to 128 printable characters. */
export const microsoftClientStateOk = (value: unknown): value is string => typeof value === "string" && CLIENT_STATE.test(value);

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/**
 * Whether a notification body has at least one notification carrying this
 * clientState, compared in constant time, so the sync should run. Graph
 * sends no signature for these notifications, so the clientState is the
 * only proof one came from the subscription.
 */
export function microsoftWebhookPrompts(body: unknown, clientState: string): boolean {
  if (!microsoftClientStateOk(clientState)) return false;
  const value = typeof body === "object" && body !== null ? (body as { value?: unknown }).value : undefined;
  if (!Array.isArray(value) || value.length > 1000) return false;
  const expected = digest(clientState);
  let match = false;
  for (const n of value) {
    const given = typeof n === "object" && n !== null ? (n as { clientState?: unknown }).clientState : undefined;
    if (typeof given === "string" && timingSafeEqual(digest(given), expected)) match = true;
  }
  return match;
}
