import { createHmac, timingSafeEqual } from "node:crypto";
import { SLACK_CHANNEL_ID } from "./client.js";
import type { SlackBrainEvent, SlackMessage, SlackNormalizer } from "./normalize.js";

/**
 * Slack's Events API. Each delivery is a POST signed with the app's signing
 * secret. A message event carries the message itself, so it becomes the
 * same event the sync would make, under the same key: a delivery for a
 * message already synced, or a delivery Slack retries, is a duplicate.
 */

export type SlackSignatureCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

export interface SlackWebhookRequest {
  /** The raw body, before it is parsed. */
  body: string | Buffer;
  /** X-Slack-Signature: v0= and a hex HMAC-SHA256. */
  signature: string | undefined;
  /** X-Slack-Request-Timestamp, in seconds. */
  timestamp: string | undefined;
}

/** Deliveries older (or further in the future) than this are refused, as Slack's docs ask. */
export const SLACK_WEBHOOK_TOLERANCE_S = 300;

/**
 * Checks X-Slack-Signature: `v0=` and the hex HMAC-SHA256 of
 * `v0:<timestamp>:<raw body>`, keyed with SLACK_SIGNING_SECRET, compared in
 * constant time. A timestamp more than five minutes from now is refused
 * before the signature is checked, so a captured delivery can't be replayed
 * later. Check before parsing the body, and answer anything but ok with 401.
 */
export function verifySlackWebhook(signingSecret: string, request: SlackWebhookRequest, now: number = Date.now()): SlackSignatureCheck {
  if (!signingSecret || !request.signature || !request.timestamp) return { ok: false, reason: "missing" };
  const signature = request.signature.trim();
  const timestamp = request.timestamp.trim();
  if (!/^v0=[0-9a-f]{64}$/.test(signature) || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed" };
  if (Math.abs(now / 1000 - Number(timestamp)) > SLACK_WEBHOOK_TOLERANCE_S) return { ok: false, reason: "stale" };
  const body = typeof request.body === "string" ? Buffer.from(request.body, "utf8") : request.body;
  const expected = createHmac("sha256", signingSecret).update(Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), body])).digest();
  const given = Buffer.from(signature.slice(3), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/**
 * The challenge to answer a verified url_verification request with (as
 * text/plain), or null for any other delivery. Slack sends one when the
 * request URL is saved in the app's settings.
 */
export function slackUrlVerification(body: unknown): string | null {
  const b = body as { type?: unknown; challenge?: unknown } | null;
  return b && b.type === "url_verification" && typeof b.challenge === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(b.challenge) ? b.challenge : null;
}

interface MessageEvent extends SlackMessage {
  channel?: unknown;
  channel_type?: unknown;
  message?: SlackMessage;
  deleted_ts?: unknown;
}

/**
 * The events in one verified event_callback delivery: a message posted,
 * edited (message_changed) or deleted (message_deleted) in a channel or
 * private channel. Direct messages, other event types and deliveries for
 * another workspace are left out.
 */
export function slackWebhookEvents(body: unknown, normalize: SlackNormalizer, receivedAt: string, teamId?: string): SlackBrainEvent[] {
  const envelope = body as { type?: unknown; team_id?: unknown; event?: MessageEvent } | null;
  if (!envelope || envelope.type !== "event_callback" || !envelope.event || typeof envelope.event !== "object") return [];
  if (teamId !== undefined && envelope.team_id !== teamId) return [];
  const e = envelope.event;
  if (e.type !== "message" || (e.channel_type !== "channel" && e.channel_type !== "group")) return [];
  if (typeof e.channel !== "string" || !SLACK_CHANNEL_ID.test(e.channel)) return [];
  if (e.subtype === "message_deleted") return normalize.deletedEvent(e.channel, e.deleted_ts, receivedAt);
  if (e.subtype === "message_changed") return e.message && typeof e.message === "object" ? normalize.messageEvents(e.channel, e.message, receivedAt) : [];
  return normalize.messageEvents(e.channel, e, receivedAt);
}
