import { createHash, createHmac } from "node:crypto";
import { microsoftGuid } from "../microsoft_onedrive/client.js";
import { outlookTime } from "../microsoft_outlook/normalize.js";
import { TEAMS_CHANNEL_ID, TEAMS_MESSAGE_ID } from "./client.js";

/**
 * Turns one team's channel messages into Brain A events, the way Slack's
 * are:
 *
 * - A message or reply becomes `communication.message_logged`, with its
 *   channel, thread, whether it is a reply, when it was posted and last
 *   edited, who posted it, its importance, and how many attachments,
 *   mentions and reactions it carries.
 * - A message Teams says was deleted becomes `communication.message_deleted`.
 *
 * Never kept: the text (it is where customers' names, numbers and ring
 * details turn up), subjects, summaries, attachments and their links, who
 * was mentioned or reacted, channel names and every display name. A person
 * becomes `teams_user:<hash>`, an HMAC-SHA256 of their Entra object id under
 * CORRESPONDENT_HASH_KEY, so the same person is the same reference across
 * channels but the reference can't be turned back into them. Channel and
 * message ids are kept as short digests. Join, rename and other system
 * notices are skipped. A message without an id or a time that reads is
 * dead-lettered listing why.
 */

export interface TeamsEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const TEAMS_EVENTS = { message: "communication.message_logged", deleted: "communication.message_deleted" } as const;

const IMPORTANCE = new Set(["normal", "high", "urgent"]);
const short = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const digest = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);
const obj = (v: unknown) => (v ?? {}) as Record<string, unknown>;
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const messageId = (v: unknown) => (typeof v === "string" && TEAMS_MESSAGE_ID.test(v) ? v : undefined);

export function teamsNormalizer(correspondentKey: string) {
  const key = correspondentKey?.trim() ?? "";
  if (key.length < 32) throw new Error("set CORRESPONDENT_HASH_KEY to at least 32 characters; npm run secrets:setup generates one");
  const person = (userId: string) => `teams_user:${createHmac("sha256", key).update(`karatos:correspondent:v1:teams:${userId}`, "utf8").digest("hex").slice(0, 32)}`;

  function author(from: unknown): { author?: string; authorKind: "person" | "app" | "unknown" } {
    const user = microsoftGuid(obj(obj(from).user).id);
    if (user) return { author: person(user), authorKind: "person" };
    const app = microsoftGuid(obj(obj(from).application).id);
    if (app) return { author: `teams_app:${digest(app)}`, authorKind: "app" };
    return { authorKind: "unknown" };
  }

  return {
    person,

    /** A message's or reply's event, or none for a system notice. */
    message(channel: string, raw: unknown, receivedAt: string): TeamsEvent[] {
      const r = obj(raw);
      if (r.messageType !== "message" || !TEAMS_CHANNEL_ID.test(channel)) return [];
      const id = messageId(r.id);
      const parent = messageId(r.replyToId);
      const sentAt = outlookTime(r.createdDateTime);
      const deletedAt = outlookTime(r.deletedDateTime);
      const ref = (kind: string, of: string) => `teams:${kind}:${digest(`${channel}/${of}`)}`;
      const where = { system: "Teams", channel: "teams", conversationId: `teams:channel:${digest(channel)}` };
      const problems = [...(id ? [] : ["message has no id that reads"]), ...(sentAt ? [] : ["message has no time that reads"])];
      if (problems.length > 0) {
        const unreadable = `teams:unreadable_message:${short(raw)}`;
        return [{ id: unreadable.replace(/:/g, "_"), type: TEAMS_EVENTS.message, occurredAt: undefined, receivedAt, idempotencyKey: unreadable, payload: { system: "Teams", problems } }];
      }
      const ids = { messageId: ref("message", id!), threadId: ref("thread", parent ?? id!) };
      const deleted = deletedAt !== undefined;
      const payload = deleted
        ? { ...where, ...ids, deletedAt }
        : defined({
            ...where,
            ...ids,
            isReply: parent !== undefined,
            sentAt,
            editedAt: outlookTime(r.lastEditedDateTime),
            ...author(r.from),
            importance: IMPORTANCE.has(r.importance as string) ? r.importance : undefined,
            attachmentCount: count(r.attachments),
            mentionCount: count(r.mentions),
            reactionCount: count(r.reactions),
            textWithheld: true,
          });
      const idempotencyKey = `teams:message:${digest(`${channel}/${id}`)}:${short(payload)}`;
      return [{ id: idempotencyKey.replace(/:/g, "_"), type: deleted ? TEAMS_EVENTS.deleted : TEAMS_EVENTS.message, occurredAt: deleted ? deletedAt : sentAt, receivedAt, idempotencyKey, payload }];
    },
  };
}

export type TeamsNormalizer = ReturnType<typeof teamsNormalizer>;
