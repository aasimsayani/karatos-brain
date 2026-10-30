import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Gusto webhooks. A delivery names what changed but carries none of its
 * data, so a payroll event is a prompt to sync, not data: the next
 * incremental pass reads the payroll itself.
 */

export type GustoSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/**
 * Checks `X-Gusto-Signature`: the HMAC-SHA256 of the raw body, keyed with
 * the subscription's verification_token. Gusto's docs don't say whether
 * the digest is hex or base64, so either is accepted, compared in constant
 * time. Check before parsing the body, and answer anything but ok with 401.
 * Gusto retries a delivery for days and signs no timestamp, so a replay is
 * caught by the event's uuid, and in any case only prompts a sync that
 * stores nothing twice.
 */
export function verifyGustoWebhook(verificationToken: string, rawBody: string | Buffer, header: string | undefined): GustoSignatureCheck {
  if (!verificationToken || !header) return { ok: false, reason: "missing" };
  const value = header.trim();
  const given = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, "base64") : null;
  if (!given) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", verificationToken).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface GustoWebhookEvent {
  /** Gusto's id for the delivery, the same on every retry. */
  id: string;
  /** e.g. payroll.processed. */
  type: string;
  entityType: string;
  entityId: string;
  /** ISO time Gusto says the event happened. */
  time: string | undefined;
  /** True for payroll events, which the next sync should pick up. */
  syncPayrolls: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z_]+(\.[a-z_]+)+$/;
const ENTITY_TYPE = /^[A-Za-z]{1,40}$/;

/**
 * The event a verified delivery describes, when it is about this company.
 * A delivery for another company, or one not shaped like a Gusto event,
 * gives null.
 */
export function gustoWebhookEvent(body: unknown, companyUuid: string): GustoWebhookEvent | null {
  const e = (body ?? {}) as { uuid?: unknown; event_type?: unknown; resource_type?: unknown; resource_uuid?: unknown; entity_type?: unknown; entity_uuid?: unknown; timestamp?: unknown };
  if (e.resource_type !== "Company" || typeof e.resource_uuid !== "string" || e.resource_uuid.toLowerCase() !== companyUuid.trim().toLowerCase()) return null;
  if (typeof e.uuid !== "string" || !UUID.test(e.uuid) || typeof e.event_type !== "string" || !EVENT_TYPE.test(e.event_type)) return null;
  if (typeof e.entity_type !== "string" || !ENTITY_TYPE.test(e.entity_type) || typeof e.entity_uuid !== "string" || !UUID.test(e.entity_uuid)) return null;
  const seconds = typeof e.timestamp === "number" && Number.isFinite(e.timestamp) && e.timestamp > 0 ? e.timestamp : null;
  return {
    id: e.uuid.toLowerCase(),
    type: e.event_type,
    entityType: e.entity_type,
    entityId: e.entity_uuid.toLowerCase(),
    time: seconds === null ? undefined : new Date(seconds * 1000).toISOString(),
    syncPayrolls: e.entity_type === "Payroll" || e.event_type.startsWith("payroll."),
  };
}
