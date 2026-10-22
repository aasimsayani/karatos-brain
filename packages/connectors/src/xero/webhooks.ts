import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Xero webhooks. A delivery names records that changed but carries none of
 * their data, so it is a prompt to sync, not data: the connector reads the
 * change itself with the next incremental pass.
 */

export type XeroSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/**
 * Checks `x-xero-signature`: the base64 HMAC-SHA256 of the raw body, keyed
 * with the app's webhook key. Check before parsing the body. Xero's
 * intent-to-receive check sends a badly signed delivery and expects a 401,
 * so anything but ok must be answered 401. Xero signs no timestamp; a
 * replayed delivery only prompts a sync that finds nothing new.
 */
export function verifyXeroWebhook(webhookKey: string, rawBody: string | Buffer, header: string | undefined): XeroSignatureCheck {
  if (!webhookKey || !header) return { ok: false, reason: "missing" };
  const value = header.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", webhookKey).update(body).digest();
  const given = Buffer.from(value, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export const XERO_WEBHOOK_CATEGORIES = ["INVOICE", "CONTACT", "CREDITNOTE"] as const;
export type XeroWebhookCategory = (typeof XERO_WEBHOOK_CATEGORIES)[number];

export interface XeroChange {
  category: XeroWebhookCategory;
  id: string;
  /** create or update. */
  operation: "create" | "update";
  time: string | undefined;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The changes a verified delivery lists for one organisation. Events for
 * another tenant, app subscription events and anything not shaped like a
 * Xero event are left out.
 */
export function xeroWebhookChanges(body: unknown, tenantId: string): XeroChange[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((e: unknown) => {
    const event = e as { resourceId?: unknown; eventCategory?: unknown; eventType?: unknown; tenantId?: unknown; tenantType?: unknown; eventDateUtc?: unknown };
    if (!event || typeof event.tenantId !== "string" || event.tenantId.toLowerCase() !== tenantId.toLowerCase() || event.tenantType !== "ORGANISATION") return [];
    const category = XERO_WEBHOOK_CATEGORIES.find((c) => c === event.eventCategory);
    const operation = event.eventType === "CREATE" ? "create" : event.eventType === "UPDATE" ? "update" : undefined;
    if (!category || !operation || typeof event.resourceId !== "string" || !GUID.test(event.resourceId)) return [];
    return [{ category, id: event.resourceId.toLowerCase(), operation, time: typeof event.eventDateUtc === "string" ? event.eventDateUtc : undefined }];
  });
}
