import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { PlaidApiError, type PlaidClient, type PlaidVerificationKey } from "./client.js";

/**
 * Plaid webhooks. A SYNC_UPDATES_AVAILABLE notification says the Item has
 * new transaction changes but carries none, so it is a prompt to sync, not
 * data: the connector reads the changes itself with the next incremental
 * pass, and a replayed notification finds nothing new.
 *
 * Plaid signs each delivery with a JWT in the Plaid-Verification header,
 * ES256 over P-256, with a key fetched from /webhook_verification_key/get by
 * the JWT's key ID. The JWT carries the time it was issued and the SHA-256 of
 * the raw body. Only node:crypto is used.
 */

/** How old a delivery may be, in seconds. Plaid's docs say to refuse anything older than five minutes. */
export const PLAID_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

export type PlaidWebhookCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "algorithm" | "unknown_key" | "expired_key" | "signature" | "stale" | "body_mismatch" };

export interface PlaidWebhookVerifyOptions {
  /** The verification key for a key ID, or null when Plaid has no such key. */
  key: (keyId: string) => Promise<PlaidVerificationKey | null>;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Checks a delivery's Plaid-Verification JWT against the raw body, before
 * the body is parsed: the algorithm must be ES256 (never `none`), the key
 * must be Plaid's and current, the signature must hold, the JWT must be no
 * more than five minutes old, and its request_body_sha256 must match the
 * body byte for byte. Plaid hashes the body exactly as sent, so pass it
 * unparsed.
 */
export async function verifyPlaidWebhook(rawBody: string | Buffer, header: string | undefined, options: PlaidWebhookVerifyOptions): Promise<PlaidWebhookCheck> {
  if (!header) return { ok: false, reason: "missing" };
  const parts = header.trim().split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const jose = decodeJson(encodedHeader);
  if (!jose) return { ok: false, reason: "malformed" };
  // Only ES256: `none`, HS256 and every other algorithm are refused before a key is fetched.
  if (jose.alg !== "ES256") return { ok: false, reason: "algorithm" };
  if (typeof jose.kid !== "string" || !KEY_ID.test(jose.kid)) return { ok: false, reason: "malformed" };

  const jwk = await options.key(jose.kid);
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || (jwk.alg !== undefined && jwk.alg !== "ES256") || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    return { ok: false, reason: "unknown_key" };
  }
  const nowMs = (options.clock ?? Date.now)();
  if (typeof jwk.expired_at === "number" && jwk.expired_at * 1000 <= nowMs) return { ok: false, reason: "expired_key" };

  // ES256 signatures in a JWT are the raw 64-byte r and s, not DER.
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64) return { ok: false, reason: "signature" };
  let valid = false;
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    valid = verify("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`), { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return { ok: false, reason: "unknown_key" };
  }
  if (!valid) return { ok: false, reason: "signature" };

  const claims = decodeJson(encodedPayload);
  if (!claims) return { ok: false, reason: "malformed" };
  const age = nowMs / 1000 - (typeof claims.iat === "number" ? claims.iat : Number.NaN);
  // Too old to trust, or dated in the future beyond the same allowance for clock drift.
  if (!(Math.abs(age) <= PLAID_WEBHOOK_MAX_AGE_SECONDS)) return { ok: false, reason: "stale" };

  const claimed = typeof claims.request_body_sha256 === "string" ? claims.request_body_sha256.toLowerCase() : "";
  if (!HEX_SHA256.test(claimed)) return { ok: false, reason: "body_mismatch" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const actual = createHash("sha256").update(body).digest();
  return timingSafeEqual(Buffer.from(claimed, "hex"), actual) ? { ok: true } : { ok: false, reason: "body_mismatch" };
}

/**
 * Fetches verification keys from Plaid by key ID, keeping each one for the
 * life of the instance so a burst of deliveries asks Plaid once. A key ID
 * Plaid doesn't know comes back as null; any other failure is thrown, so a
 * Plaid outage isn't mistaken for a forged delivery.
 */
export function plaidWebhookKeys(client: Pick<PlaidClient, "webhookVerificationKey">): (keyId: string) => Promise<PlaidVerificationKey | null> {
  const keys = new Map<string, PlaidVerificationKey>();
  return async (keyId) => {
    const known = keys.get(keyId);
    // A cached key is fetched again once it has expired, in case Plaid changed it.
    if (known && known.expired_at == null) return known;
    try {
      const key = await client.webhookVerificationKey(keyId);
      keys.set(keyId, key);
      return key;
    } catch (error) {
      if (error instanceof PlaidApiError && error.status >= 400 && error.status < 500 && error.status !== 429) return null;
      throw error;
    }
  };
}

export interface PlaidSyncPrompt {
  itemId: string;
  /** Plaid has at least 30 days of history ready. */
  initialUpdateComplete: boolean;
  /** Plaid has the whole history ready. */
  historicalUpdateComplete: boolean;
}

/**
 * The sync prompt in a verified notification, or null when it isn't one:
 * another webhook type or code, another Item, or anything not shaped like
 * Plaid's notification.
 */
export function plaidSyncPrompt(body: unknown, itemId?: string): PlaidSyncPrompt | null {
  const b = body as { webhook_type?: unknown; webhook_code?: unknown; item_id?: unknown; initial_update_complete?: unknown; historical_update_complete?: unknown } | null;
  if (!b || typeof b !== "object" || b.webhook_type !== "TRANSACTIONS" || b.webhook_code !== "SYNC_UPDATES_AVAILABLE") return null;
  if (typeof b.item_id !== "string" || !KEY_ID.test(b.item_id) || (itemId !== undefined && b.item_id !== itemId)) return null;
  return { itemId: b.item_id, initialUpdateComplete: b.initial_update_complete === true, historicalUpdateComplete: b.historical_update_complete === true };
}
