import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Authorize.net webhooks. A delivery carries only some of a transaction's
 * details, and Authorize.net says to read the rest from the API, so a
 * delivery is a prompt to sync, not data: the connector reads the
 * transaction itself on the next incremental pass.
 */

export type AuthorizeNetSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

const SIGNATURE = /^sha512=([0-9a-f]{128})$/i;

/**
 * Checks `X-ANET-Signature`: `sha512=` and the hex HMAC-SHA512 of the raw
 * body, keyed with the merchant's Signature Key as text. Authorize.net
 * writes the hex in upper case; either case is accepted. Check before
 * parsing the body, and answer anything but ok with a 401. Authorize.net
 * signs no timestamp; a replayed delivery only prompts a sync that finds
 * nothing new.
 */
export function verifyAuthorizeNetWebhook(signatureKey: string, rawBody: string | Buffer, header: string | undefined): AuthorizeNetSignatureCheck {
  if (!signatureKey || !header) return { ok: false, reason: "missing" };
  const m = SIGNATURE.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha512", signatureKey).update(body).digest();
  const given = Buffer.from(m[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** The payment events the connector listens for. Fraud and customer profile events aren't read. */
export const AUTHORIZE_NET_WEBHOOK_EVENTS = [
  "net.authorize.payment.authorization.created",
  "net.authorize.payment.authcapture.created",
  "net.authorize.payment.capture.created",
  "net.authorize.payment.priorAuthCapture.created",
  "net.authorize.payment.refund.created",
  "net.authorize.payment.void.created",
] as const;
export type AuthorizeNetWebhookEvent = (typeof AUTHORIZE_NET_WEBHOOK_EVENTS)[number];

export interface AuthorizeNetChange {
  eventType: AuthorizeNetWebhookEvent;
  transactionId: string;
  time: string | undefined;
}

/**
 * The transaction a verified delivery names, if it is a payment event the
 * connector reads. Nothing else from the payload is kept.
 */
export function authorizeNetWebhookChange(body: unknown): AuthorizeNetChange | null {
  const n = body as { eventType?: unknown; eventDate?: unknown; payload?: { entityName?: unknown; id?: unknown } } | null;
  const eventType = AUTHORIZE_NET_WEBHOOK_EVENTS.find((e) => e === n?.eventType);
  const id = n?.payload?.id;
  if (!eventType || n?.payload?.entityName !== "transaction" || typeof id !== "string" || !/^\d{1,20}$/.test(id)) return null;
  return { eventType, transactionId: id, time: typeof n.eventDate === "string" ? n.eventDate : undefined };
}
