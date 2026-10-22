import { createHmac, timingSafeEqual } from "node:crypto";
import type { HubSpotObject } from "./client.js";

/**
 * HubSpot webhooks. A delivery names records that changed, and at most one
 * property value, so it is a prompt to sync, not data: the connector reads
 * the change itself with the next incremental pass, keeping only what the
 * sync keeps.
 */

export type HubSpotSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

export interface HubSpotWebhookRequest {
  /** The HTTP method HubSpot used, usually POST. */
  method: string;
  /** The full URL HubSpot called, https://host/path?query, as configured in the app. */
  uri: string;
  /** The raw body, before it is parsed. */
  body: string | Buffer;
  /** X-HubSpot-Signature-v3. */
  signature: string | undefined;
  /** X-HubSpot-Request-Timestamp, in milliseconds. */
  timestamp: string | undefined;
}

/** Deliveries older (or further in the future) than this are refused, as HubSpot's docs ask. */
export const HUBSPOT_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/** The URL-encoded characters HubSpot decodes in the URI before signing. Nothing else is decoded. */
const DECODED: Record<string, string> = { "3A": ":", "2F": "/", "3F": "?", "40": "@", "21": "!", "24": "$", "27": "'", "28": "(", "29": ")", "2A": "*", "2C": ",", "3B": ";" };
const decodeUri = (uri: string) => uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (_, hex: string) => DECODED[hex.toUpperCase()]!);

/**
 * Checks X-HubSpot-Signature-v3: the base64 HMAC-SHA256 of method, URI, raw
 * body and timestamp run together, keyed with the app's client secret. A
 * timestamp more than five minutes from now is refused before the signature
 * is checked, so a captured delivery can't be replayed later. Check before
 * parsing the body, and answer anything but ok with 401.
 */
export function verifyHubSpotWebhook(clientSecret: string, request: HubSpotWebhookRequest, now: number = Date.now()): HubSpotSignatureCheck {
  if (!clientSecret || !request.signature || !request.timestamp) return { ok: false, reason: "missing" };
  const signature = request.signature.trim();
  const timestamp = request.timestamp.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature) || !/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: "malformed" };
  if (Math.abs(now - Number(timestamp)) > HUBSPOT_WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "stale" };
  const body = typeof request.body === "string" ? Buffer.from(request.body, "utf8") : request.body;
  const expected = createHmac("sha256", clientSecret)
    .update(Buffer.concat([Buffer.from(`${request.method.toUpperCase()}${decodeUri(request.uri)}`, "utf8"), body, Buffer.from(timestamp, "utf8")]))
    .digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Subscription prefixes and the objects they name. */
const OBJECTS: Record<string, HubSpotObject> = { contact: "contacts", company: "companies", deal: "deals", ticket: "tickets" };
const CHANGES = ["creation", "deletion", "propertyChange", "merge", "restore", "associationChange", "privacyDeletion"] as const;
export type HubSpotChangeKind = (typeof CHANGES)[number];

export interface HubSpotChange {
  object: HubSpotObject;
  id: string;
  change: HubSpotChangeKind;
  /** When HubSpot says it happened, as an ISO time. */
  time: string | undefined;
}

/**
 * The changes a verified delivery lists for one account (HubSpot's portalId).
 * Property values aren't kept, and events for another account or of a kind
 * the connector doesn't read are left out.
 */
export function hubSpotWebhookChanges(body: unknown, portalId: number): HubSpotChange[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((e: unknown) => {
    const event = e as { objectId?: unknown; subscriptionType?: unknown; eventType?: unknown; portalId?: unknown; occurredAt?: unknown };
    if (!event || event.portalId !== portalId) return [];
    // The docs name the field subscriptionType, though their example writes eventType.
    const type = typeof event.subscriptionType === "string" ? event.subscriptionType : typeof event.eventType === "string" ? event.eventType : "";
    const [prefix, kind] = type.split(".");
    const object = prefix !== undefined && Object.hasOwn(OBJECTS, prefix) ? OBJECTS[prefix] : undefined;
    const change = CHANGES.find((c) => c === kind);
    const id = typeof event.objectId === "number" && Number.isSafeInteger(event.objectId) && event.objectId > 0 ? String(event.objectId) : undefined;
    if (!object || !change || !id) return [];
    const time = typeof event.occurredAt === "number" && Number.isFinite(event.occurredAt) ? new Date(event.occurredAt).toISOString() : undefined;
    return [{ object, id, change, time }];
  });
}
