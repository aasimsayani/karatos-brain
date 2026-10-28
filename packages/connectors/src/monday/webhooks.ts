import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * monday.com webhooks. A delivery names the board, item and kind of change,
 * plus the item's name and the new value, so it is a prompt to sync, never
 * data: nothing from the body is kept, and the next incremental pass reads
 * the change with the connector's own filters.
 *
 * Creating a webhook sends a challenge first, which must be echoed back.
 * monday.com's docs describe a JWT in the Authorization header, signed with
 * the app's Signing Secret, for webhooks created with a monday app's token.
 * A webhook set up another way, such as from a board's automations, may
 * arrive unsigned, so it can't be trusted beyond prompting a sync.
 */

export type MondaySignatureCheck =
  | { ok: true; accountId: string | undefined; userId: string | undefined }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" | "expired" | "audience" };

/** Seconds of clock difference allowed when checking a token's exp and iat. */
export const MONDAY_WEBHOOK_LEEWAY_SECONDS = 30;

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^\d{1,20}$/;

const json = (part: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const idOf = (v: unknown) => {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v : "";
  return ID.test(s) ? s : undefined;
};

/**
 * Checks the JWT in a delivery's Authorization header: HS256 only, so a
 * token claiming "none" or another algorithm is refused, signed with the
 * app's Signing Secret and compared in constant time. The token must carry
 * an exp that hasn't passed, which is what stops a captured delivery being
 * replayed later; an iat in the future is refused too. When `audience` is
 * given, aud must equal it. Check before parsing the body and answer
 * anything but ok with a 401. The short-lived API token inside is never
 * returned or kept.
 */
export function verifyMondayWebhook(
  signingSecret: string,
  authorization: string | undefined,
  options: { nowSeconds?: number; audience?: string; leewaySeconds?: number } = {},
): MondaySignatureCheck {
  if (!signingSecret || !authorization) return { ok: false, reason: "missing" };
  const token = authorization.trim().replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return { ok: false, reason: "malformed" };
  const [head, body, signature] = parts as [string, string, string];
  const header = json(head);
  const claims = json(body);
  if (!header || !claims || header.alg !== "HS256") return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", signingSecret).update(`${head}.${body}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const leeway = options.leewaySeconds ?? MONDAY_WEBHOOK_LEEWAY_SECONDS;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || now > claims.exp + leeway) return { ok: false, reason: "expired" };
  if (typeof claims.iat === "number" && claims.iat > now + leeway) return { ok: false, reason: "expired" };
  if (options.audience !== undefined && claims.aud !== options.audience) return { ok: false, reason: "audience" };
  return { ok: true, accountId: idOf(claims.accountId), userId: idOf(claims.userId) };
}

/**
 * The answer to the challenge monday.com sends when a webhook is created:
 * the same token back as `challenge`. Null for anything else, so a real
 * delivery is never echoed.
 */
export function mondayWebhookChallenge(body: unknown): { challenge: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const challenge = (body as { challenge?: unknown }).challenge;
  if (keys.length !== 1 || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(challenge)) return null;
  return { challenge };
}

export interface MondayChange {
  /** monday.com's event type, such as create_pulse or update_column_value. */
  type: string;
  boardId: string;
  itemId: string | undefined;
  time: string | undefined;
}

/**
 * What a verified delivery says changed, for deciding to sync: the event
 * type and the board and item ids. The item's name, column values and the
 * user are left out.
 */
export function mondayWebhookChanges(body: unknown): MondayChange[] {
  const event = (body as { event?: unknown } | null)?.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== "object") return [];
  const type = typeof event.type === "string" && /^[a-z_]{1,60}$/.test(event.type) ? event.type : undefined;
  const boardId = idOf(event.boardId);
  if (!type || !boardId) return [];
  const time = typeof event.triggerTime === "string" && !Number.isNaN(Date.parse(event.triggerTime)) ? new Date(event.triggerTime).toISOString() : undefined;
  return [{ type, boardId, itemId: idOf(event.pulseId), time }];
}
