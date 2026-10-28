import { createHash, timingSafeEqual } from "node:crypto";
import { CLOVER_ID } from "./client.js";

/**
 * Clover app webhooks. A notification names what changed (an object ID and
 * CREATE, UPDATE or DELETE) without the record, so it is a prompt to sync,
 * not data: the connector reads the change itself with the next incremental
 * pass.
 *
 * Clover doesn't sign deliveries. Each one carries the app's auth code in
 * `X-Clover-Auth`, which is compared in constant time. Because a captured
 * delivery could be sent again, notifications older than the replay window
 * are dropped and one already seen is a duplicate.
 */

export type CloverAuthCheck = { ok: true } | { ok: false; reason: "missing" | "mismatch" };

const MAX_HEADER = 256;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Checks `X-Clover-Auth` against the app's auth code, in constant time: both
 * are hashed first, so neither their content nor their length leaks. Check
 * before parsing the body; anything but ok is answered 401.
 */
export function verifyCloverWebhook(authCode: string, header: string | undefined | null): CloverAuthCheck {
  const expected = authCode?.trim() ?? "";
  if (!expected || typeof header !== "string" || !header.trim() || header.length > MAX_HEADER) return { ok: false, reason: "missing" };
  return timingSafeEqual(digest(header.trim()), digest(expected)) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * The code in Clover's one-off verification POST, sent when the webhook URL
 * is saved and before any auth code exists. The owner pastes it into the
 * app's webhook settings; it proves nothing about later deliveries. Null for
 * any other body.
 */
export function cloverVerificationCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const code = (body as { verificationCode?: unknown }).verificationCode;
  if (keys.length !== 1 || typeof code !== "string" || code.length > 64 || !/^[A-Za-z0-9-]{8,64}$/.test(code)) return null;
  return code;
}

/** Event keys Clover sends, for what the connector reads. Others (employees, cash adjustments, ...) are left out. */
export const CLOVER_WEBHOOK_KEYS = { O: "orders", P: "payments", I: "items", IS: "item_stocks", C: "customers" } as const;
export type CloverWebhookStream = (typeof CLOVER_WEBHOOK_KEYS)[keyof typeof CLOVER_WEBHOOK_KEYS];

export interface CloverChange {
  stream: CloverWebhookStream;
  id: string;
  operation: "create" | "update" | "delete";
  /** When Clover sent it, epoch milliseconds. */
  ts: number;
  /** Stable across deliveries of the same notification, for de-duplication. */
  key: string;
}

export interface CloverWebhookOptions {
  /** The merchant this instance syncs; notifications for others are dropped. */
  merchantId: string;
  /** The app's ID, when known; a notification from another app is dropped. */
  appId?: string;
  /** Milliseconds since the epoch. */
  now: number;
  /** How old a notification may be. A day by default. */
  replayWindowMs?: number;
}

export const CLOVER_REPLAY_WINDOW_MS = 24 * 3_600_000;
/** Clock skew allowed for a notification stamped in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;
const OPERATIONS = { CREATE: "create", UPDATE: "update", DELETE: "delete" } as const;
const MAX_CHANGES = 1000;

/**
 * The changes a verified notification lists for this merchant, inside the
 * replay window. Unknown event keys, malformed object IDs and anything not
 * shaped like Clover's notification are left out.
 */
export function cloverWebhookChanges(body: unknown, options: CloverWebhookOptions): CloverChange[] {
  const b = (body ?? {}) as { appId?: unknown; merchants?: unknown };
  if (options.appId !== undefined && b.appId !== options.appId) return [];
  const merchants = b.merchants;
  if (!merchants || typeof merchants !== "object" || Array.isArray(merchants)) return [];
  const list = Object.hasOwn(merchants, options.merchantId) ? (merchants as Record<string, unknown>)[options.merchantId] : undefined;
  if (!Array.isArray(list)) return [];
  const window = options.replayWindowMs ?? CLOVER_REPLAY_WINDOW_MS;
  return list.slice(0, MAX_CHANGES).flatMap((entry: unknown) => {
    const e = (entry ?? {}) as { objectId?: unknown; type?: unknown; ts?: unknown };
    if (typeof e.objectId !== "string" || e.objectId.length > 20) return [];
    const colon = e.objectId.indexOf(":");
    const prefix = colon > 0 ? e.objectId.slice(0, colon) : "";
    const id = e.objectId.slice(colon + 1);
    const stream = Object.hasOwn(CLOVER_WEBHOOK_KEYS, prefix) ? CLOVER_WEBHOOK_KEYS[prefix as keyof typeof CLOVER_WEBHOOK_KEYS] : undefined;
    const operation = typeof e.type === "string" && Object.hasOwn(OPERATIONS, e.type) ? OPERATIONS[e.type as keyof typeof OPERATIONS] : undefined;
    if (!stream || !operation || !CLOVER_ID.test(id)) return [];
    if (typeof e.ts !== "number" || !Number.isInteger(e.ts) || e.ts < options.now - window || e.ts > options.now + FUTURE_SKEW_MS) return [];
    return [{ stream, id, operation, ts: e.ts, key: `${options.merchantId}:${prefix}:${id}:${e.type}:${e.ts}` }];
  });
}

/**
 * Remembers the notifications already taken, so a replay inside the window
 * is a duplicate. Bounded: the oldest are forgotten first, and anything older
 * than the window is dropped by cloverWebhookChanges anyway.
 */
export class CloverWebhookDeduper {
  private readonly seen = new Map<string, number>();

  constructor(private readonly max = 10_000) {}

  /** The changes not seen before, remembering them. */
  fresh(changes: readonly CloverChange[]): CloverChange[] {
    const out: CloverChange[] = [];
    for (const change of changes) {
      if (this.seen.has(change.key)) continue;
      this.seen.set(change.key, change.ts);
      out.push(change);
      if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    }
    return out;
  }
}
