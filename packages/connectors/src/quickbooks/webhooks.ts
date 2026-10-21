import { createHmac, timingSafeEqual } from "node:crypto";
import { QUICKBOOKS_ENTITIES, type QuickBooksEntity } from "./normalize.js";

/**
 * QuickBooks webhooks, in the CloudEvents format Intuit moved every app to
 * by 31 July 2026. A notification names what changed but carries no record,
 * so it is a prompt to sync, not data: the connector reads the change itself
 * with the next incremental pass.
 */

export type QuickBooksSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

/**
 * Checks `intuit-signature`: the base64 HMAC-SHA256 of the raw body, keyed
 * with the app's webhook verifier token. Check before parsing the body.
 * Intuit signs no timestamp, so replays are caught by the event keys instead:
 * a replayed notification only prompts a sync that finds nothing new.
 */
export function verifyQuickBooksWebhook(verifierToken: string, rawBody: string | Buffer, header: string | undefined): QuickBooksSignatureCheck {
  if (!verifierToken || !header) return { ok: false, reason: "missing" };
  const value = header.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", verifierToken).update(body).digest();
  const given = Buffer.from(value, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface QuickBooksChange {
  entity: QuickBooksEntity;
  id: string;
  /** Intuit's operation: created, updated, deleted, merged, voided and so on. */
  operation: string;
  time: string | undefined;
}

const ENTITY_BY_NAME = new Map<string, QuickBooksEntity>(QUICKBOOKS_ENTITIES.map((e) => [e.toLowerCase(), e]));
const TYPE = /^qbo\.([a-z]+)\.([a-z]+)\.v\d+$/;

/**
 * The changes a verified notification lists for one company, limited to the
 * entities the connector reads. Events for another company, unknown types and
 * anything not shaped like a CloudEvent are left out.
 */
export function quickBooksWebhookChanges(body: unknown, realmId: string): QuickBooksChange[] {
  const events = Array.isArray(body) ? body : [];
  return events.flatMap((e: unknown) => {
    const event = e as { specversion?: unknown; type?: unknown; intuitentityid?: unknown; intuitaccountid?: unknown; time?: unknown };
    if (!event || event.specversion !== "1.0" || event.intuitaccountid !== realmId) return [];
    const match = typeof event.type === "string" ? TYPE.exec(event.type) : null;
    const entity = match ? ENTITY_BY_NAME.get(match[1]!) : undefined;
    if (!entity || typeof event.intuitentityid !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(event.intuitentityid)) return [];
    return [{ entity, id: event.intuitentityid, operation: match![2]!, time: typeof event.time === "string" ? event.time : undefined }];
  });
}
