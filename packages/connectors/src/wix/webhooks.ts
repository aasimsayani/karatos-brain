import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { wixContactEvent, wixId, wixInventoryItemEvents, wixOrderEvents, wixTime, type WixBrainEvent, type WixContext, type WixRecord } from "./normalize.js";

/**
 * Wix webhooks. Wix sends webhooks to apps only (an API key gets none). Each
 * delivery's body is a JWT signed with the app's key pair (RS256); the
 * public key is on the app dashboard's Webhooks page (WIX_WEBHOOK_PUBLIC_KEY).
 * The token's `data` claim is a JSON string holding `eventType`,
 * `instanceId` and the event itself, again as a JSON string, with its `id`,
 * `entityFqdn`, `slug`, `eventTime` and the entity.
 *
 * `verifyWixWebhook` checks, before anything is parsed further: the token's
 * shape, that its algorithm is RS256 (never `none` or an HMAC, which would
 * let the public key sign), the signature, `exp`, `nbf` and `iat` when the
 * token has them, `iss` when it has one, and that the event is for this
 * site's app instance.
 *
 * Wix retries a delivery for up to about 47 hours and may send one event
 * more than once, so replays are handled three ways:
 * - `WixReplayGuard` handles each event ID once within 49 hours;
 * - an event older than 48 hours gives no events (the sync reads it);
 * - the event keys are the sync's own, so a replay that gets through still
 *   stores nothing twice, even after a restart.
 *
 * Order, contact and V3 inventory item events carry the whole entity and
 * become events. Product events carry no variants (V3) or only the changed
 * fields (V1), and deletions only an ID, so they are a prompt to sync.
 */

export type WixWebhookCheck =
  | { ok: true; delivery: WixWebhookDelivery }
  | { ok: false; reason: "missing" | "malformed" | "algorithm" | "signature" | "expired" | "issuer" | "instance" };

/** A verified delivery: the event, unwrapped from the token. */
export interface WixWebhookDelivery {
  eventId: string;
  eventType: string;
  instanceId: string;
  entityFqdn: string;
  slug: string;
  eventTime: string | undefined;
  /** The entity after the event: createdEvent.entity or updatedEvent.currentEntity. */
  entity: WixRecord | null;
}

/** Issuers a Wix webhook token may name. A token without `iss` is accepted on its signature. */
export const WIX_WEBHOOK_ISSUERS = ["wix.com"] as const;
/** The largest webhook body read; an order with many lines is a few hundred kilobytes. */
export const WIX_MAX_WEBHOOK_BYTES = 2_000_000;
/** Clock difference allowed on exp, nbf and iat. */
export const WIX_CLOCK_LEEWAY_MS = 60_000;

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const EVENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const NAME = /^[a-z0-9_.]{1,120}$/;

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const objectOf = (value: unknown): WixRecord | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as WixRecord) : undefined);
const decode = (segment: string) => objectOf(json(Buffer.from(segment, "base64url").toString("utf8")));

/** The app's public key, PEM, as copied from the dashboard. Undefined when it isn't an RSA public key. */
export function wixWebhookKey(pem: string | undefined): KeyObject | undefined {
  if (typeof pem !== "string" || pem.length > 10_000 || !pem.includes("PUBLIC KEY")) return undefined;
  try {
    const key = createPublicKey(pem.trim());
    return key.asymmetricKeyType === "rsa" ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies one webhook body (the raw JWT) and unwraps its event. Anything
 * but ok is answered 401 and dropped. Check before acting on the body.
 */
export function verifyWixWebhook(publicKey: string | KeyObject | undefined, rawBody: string | Buffer | undefined, expected: { instanceId: string; now: Date }): WixWebhookCheck {
  const key = typeof publicKey === "string" || publicKey === undefined ? wixWebhookKey(publicKey) : publicKey;
  if (!key || rawBody === undefined || rawBody === null) return { ok: false, reason: "missing" };
  if (rawBody.length > WIX_MAX_WEBHOOK_BYTES) return { ok: false, reason: "malformed" };
  const token = (typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")).trim();
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = decode(h);
  if (!header) return { ok: false, reason: "malformed" };
  // Pinned: an HMAC or `none` token would be "signed" with a public key anyone can read.
  if (header.alg !== "RS256" || header.crit !== undefined) return { ok: false, reason: "algorithm" };
  let good = false;
  try {
    good = verify("RSA-SHA256", Buffer.from(`${h}.${p}`, "utf8"), key, Buffer.from(s, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "signature" };

  const claims = decode(p);
  if (!claims) return { ok: false, reason: "malformed" };
  const nowMs = expected.now.getTime();
  const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v * 1000 : null);
  for (const name of ["exp", "nbf", "iat"] as const) {
    if (claims[name] !== undefined && seconds(claims[name]) === null) return { ok: false, reason: "malformed" };
  }
  const exp = seconds(claims.exp);
  const nbf = seconds(claims.nbf);
  const iat = seconds(claims.iat);
  if ((exp !== null && nowMs > exp + WIX_CLOCK_LEEWAY_MS) || (nbf !== null && nowMs < nbf - WIX_CLOCK_LEEWAY_MS) || (iat !== null && iat > nowMs + WIX_CLOCK_LEEWAY_MS)) {
    return { ok: false, reason: "expired" };
  }
  if (claims.iss !== undefined && !(WIX_WEBHOOK_ISSUERS as readonly unknown[]).includes(claims.iss)) return { ok: false, reason: "issuer" };

  const envelope = typeof claims.data === "string" ? objectOf(json(claims.data)) : undefined;
  if (!envelope || typeof envelope.eventType !== "string" || !NAME.test(envelope.eventType) || typeof envelope.data !== "string") return { ok: false, reason: "malformed" };
  if (typeof envelope.instanceId !== "string" || envelope.instanceId.toLowerCase() !== expected.instanceId.trim().toLowerCase()) return { ok: false, reason: "instance" };
  const inner = objectOf(json(envelope.data));
  if (!inner || typeof inner.id !== "string" || !EVENT_ID.test(inner.id)) return { ok: false, reason: "malformed" };
  const entity = objectOf(objectOf(inner.createdEvent)?.entity) ?? objectOf(objectOf(inner.updatedEvent)?.currentEntity) ?? null;
  return {
    ok: true,
    delivery: {
      eventId: inner.id,
      eventType: envelope.eventType,
      instanceId: envelope.instanceId.toLowerCase(),
      entityFqdn: typeof inner.entityFqdn === "string" && NAME.test(inner.entityFqdn) ? inner.entityFqdn : "",
      slug: typeof inner.slug === "string" && NAME.test(inner.slug) ? inner.slug : "",
      eventTime: wixTime(inner.eventTime),
      entity,
    },
  };
}

/** Event IDs are remembered this long: past Wix's last retry, about 47 hours after the event. */
export const WIX_REPLAY_WINDOW_MS = 49 * 3_600_000;
/** An event older than this gives no events; the sync reads it instead. */
export const WIX_STALE_DELIVERY_MS = 48 * 3_600_000;

/**
 * Remembers recent event IDs so a replayed or duplicated delivery is handled
 * once. In memory only: the event keys stop a replay from storing anything
 * twice even after a restart.
 */
export class WixReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;

  constructor(options: { windowMs?: number; maxEntries?: number; clock?: () => number } = {}) {
    this.windowMs = options.windowMs ?? WIX_REPLAY_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** True the first time an event ID is seen within the window; false for a replay or an unreadable ID. */
  firstDelivery(eventId: string | undefined): boolean {
    if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) return false;
    const id = eventId.toLowerCase();
    const now = this.clock();
    // Insertion order is arrival order, so expired IDs are always at the front.
    for (const [seenId, at] of this.seen) {
      if (now - at < this.windowMs) break;
      this.seen.delete(seenId);
    }
    if (this.seen.has(id)) return false;
    for (const oldest of this.seen.keys()) {
      if (this.seen.size < this.maxEntries) break;
      this.seen.delete(oldest);
    }
    this.seen.set(id, now);
    return true;
  }
}

/** Entities whose created and updated events carry a record the connector keeps. */
export const WIX_WEBHOOK_DATA_ENTITIES = ["wix.ecom.v1.order", "wix.contacts.v4.contact", "wix.stores.catalog.v3.inventory_item"] as const;

/**
 * Events for one verified delivery. A stale event, an unknown entity, a
 * deletion, a product event or an entity of the wrong shape gives none.
 */
export function wixWebhookEvents(delivery: WixWebhookDelivery, ctx: WixContext, now: Date): WixBrainEvent[] {
  if (!delivery || typeof delivery !== "object") return [];
  const entity = delivery.entity;
  if (!entity || (delivery.slug !== "created" && delivery.slug !== "updated")) return [];
  const at = delivery.eventTime ? Date.parse(delivery.eventTime) : Number.NaN;
  if (Number.isNaN(at) || now.getTime() - at > WIX_STALE_DELIVERY_MS) return [];
  if (!wixId(entity.id)) return [];
  if (delivery.entityFqdn === "wix.ecom.v1.order") return wixOrderEvents(entity, ctx);
  if (delivery.entityFqdn === "wix.contacts.v4.contact") {
    const made = wixContactEvent(entity, ctx);
    return made ? [made] : [];
  }
  if (delivery.entityFqdn === "wix.stores.catalog.v3.inventory_item") return wixInventoryItemEvents(entity, ctx);
  return [];
}
