import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Dropbox webhooks. When a webhook URI is added to the app, Dropbox checks
 * it with a GET carrying `?challenge=`, which must be echoed back as plain
 * text. After that each notification is a POST whose `X-Dropbox-Signature`
 * header is the hex HMAC-SHA256 of the raw body, keyed with the app secret.
 * The body only lists the accounts with changes; it carries no file data,
 * so a notification is a prompt to run the incremental sync, which reads
 * the change itself. A replayed notification only prompts a sync that finds
 * nothing new.
 */

export type DropboxSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" };

const SIGNATURE = /^[0-9a-f]{64}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{1,200}$/;
const ACCOUNT_ID = /^dbid:[A-Za-z0-9_-]{1,100}$/;

/** The answer to Dropbox's check of the webhook URI: the challenge echoed as plain text, or a 400. */
export function dropboxWebhookChallenge(challenge: string | null | undefined): { status: 200 | 400; body: string; headers: Record<string, string> } {
  const headers = { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" };
  return typeof challenge === "string" && CHALLENGE.test(challenge) ? { status: 200, body: challenge, headers } : { status: 400, body: "", headers };
}

/** Checks a notification's signature against the raw body, in constant time. Check before parsing the body. */
export function verifyDropboxWebhook(appSecret: string, rawBody: string | Buffer, signature: string | null | undefined): DropboxSignatureCheck {
  const secret = appSecret?.trim() ?? "";
  if (!secret || !signature) return { ok: false, reason: "missing" };
  const given = signature.trim().toLowerCase();
  if (!SIGNATURE.test(given)) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest();
  return timingSafeEqual(Buffer.from(given, "hex"), expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Whether a verified notification names this account, so the sync should run. */
export function dropboxWebhookNames(body: unknown, accountId: string): boolean {
  if (!ACCOUNT_ID.test(accountId)) return false;
  const listFolder = typeof body === "object" && body !== null ? (body as { list_folder?: unknown }).list_folder : undefined;
  const accounts = typeof listFolder === "object" && listFolder !== null ? (listFolder as { accounts?: unknown }).accounts : undefined;
  return Array.isArray(accounts) && accounts.length <= 10_000 && accounts.includes(accountId);
}
