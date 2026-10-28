import { createHash, createHmac } from "node:crypto";
import { SLACK_CHANNEL_ID, SLACK_TS } from "./client.js";

/**
 * Turns Slack channels and messages into Brain A events:
 * communication.channel_updated for each channel the bot is in,
 * communication.message_logged for each version of a message, and
 * communication.message_deleted when one is deleted.
 *
 * Message text is what makes Slack worth reading, and also where customers'
 * names, numbers and addresses turn up, so the minimum is kept:
 *
 * - Text is kept only for the channels the owner lists in
 *   SLACK_TEXT_CHANNELS (or every channel the bot is in, with `all`). By
 *   default no text is kept, only who posted, when, where, in which thread
 *   and how much came with it.
 * - Kept text is redacted first: email addresses, phone numbers and any
 *   other run of seven or more digits, links (only the site's host is
 *   kept), and mentions of people, which become the same keyed reference
 *   as the author. It is cut at 4,000 characters.
 * - People are never named. A Slack user id becomes `slack_user:<hash>`,
 *   an HMAC-SHA256 under CORRESPONDENT_HASH_KEY (the key Gmail uses), so the
 *   same person is the same reference across channels and threads, but the
 *   reference can't be turned back into a user or matched against another
 *   instance's. Display names, profiles and email addresses are never read.
 * - Files are counted, never fetched: no names, titles, previews or links.
 *   Reactions are counted without who reacted. Blocks and attachments are
 *   dropped (they repeat the text or carry unfurled pages).
 * - Join, leave, topic, purpose, rename, pin and other channel notices are
 *   skipped.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface SlackBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Which channels keep their text: none (the default), every channel the bot is in, or the listed channel ids. */
export type SlackTextChannels = "none" | "all" | readonly string[];

export interface SlackNormalizeOptions {
  /** This instance's key for people references (CORRESPONDENT_HASH_KEY). At least 32 characters. */
  correspondentKey: string;
  textChannels?: SlackTextChannels;
}

/** Untrusted text is cut here before any pattern sees it. Slack allows 40,000 characters; a business message is far shorter. */
export const SLACK_TEXT_INPUT_MAX = 12_000;
/** Kept text is cut here after redaction. */
export const SLACK_TEXT_KEPT_MAX = 4000;

/** Message subtypes that are someone saying something. Everything else is a channel notice and is skipped. */
const SPOKEN = new Set(["thread_broadcast", "bot_message", "file_share", "me_message"]);
const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const BOT_ID = /^B[A-Z0-9]{2,20}$/;

/**
 * One pass over the text, each alternative bounded and none overlapping the
 * next, so hostile text can't make it slow:
 * 1. Slack's own markup, `<target>` or `<target|label>`: mentions, channels, links.
 * 2. A bare email address.
 * 3. A run of seven or more digits, with up to three spaces, dots, dashes or brackets between them: phone, order, card or account numbers.
 */
const REDACT = /<([^<>|\s]{1,300})(?:\|[^<>]{0,300})?>|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|\+?\d(?:[ ().-]{0,3}\d){6,18}/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** SLACK_TEXT_CHANNELS: empty or `none`, `all`, or channel ids separated by commas. */
export function slackTextChannels(value: string | undefined): SlackTextChannels {
  const v = value?.trim() ?? "";
  if (v === "" || v === "none") return "none";
  if (v === "all") return "all";
  const ids = v.slice(0, 20_000).split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > 500 || !ids.every((id) => SLACK_CHANNEL_ID.test(id))) {
    throw new Error("SLACK_TEXT_CHANNELS must be none, all, or channel ids like C0123ABCD separated by commas");
  }
  return [...new Set(ids)];
}

/** A Slack timestamp (seconds.microseconds) as an ISO time. */
export function slackTsToIso(ts: string): string {
  const [seconds, micros] = ts.split(".");
  return new Date(Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)).toISOString();
}

/** An ISO time or epoch milliseconds as a Slack timestamp, for oldest. */
export function slackTsFrom(ms: number): string {
  const whole = Math.floor(ms / 1000);
  return `${whole}.${String(Math.floor(ms - whole * 1000) * 1000).padStart(6, "0")}`;
}

const shortHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);
const validTs = (value: unknown): value is string => typeof value === "string" && SLACK_TS.test(value);

export const slackRef = (kind: "channel" | "message" | "thread", channel: string, ts?: string) => (ts ? `slack:${kind}:${channel}:${ts}` : `slack:${kind}:${channel}`);

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): SlackBrainEvent {
  return { id: `slack_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `slack:${key}`, payload };
}

/** A message as conversations.history, conversations.replies and the Events API carry it. */
export interface SlackMessage {
  type?: unknown;
  subtype?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  user?: unknown;
  bot_id?: unknown;
  text?: unknown;
  reply_count?: unknown;
  latest_reply?: unknown;
  files?: unknown;
  reactions?: unknown;
  edited?: { ts?: unknown };
}

/** A channel as conversations.list lists it. */
export interface SlackChannel {
  id?: unknown;
  name?: unknown;
  is_private?: unknown;
  is_archived?: unknown;
  is_member?: unknown;
  created?: unknown;
  num_members?: unknown;
}

export function slackNormalizer(options: SlackNormalizeOptions) {
  const key = options.correspondentKey?.trim() ?? "";
  if (key.length < 32) throw new Error("set CORRESPONDENT_HASH_KEY to at least 32 characters; npm run secrets:setup generates one");
  const textChannels = options.textChannels ?? "none";
  const keepsText = (channel: string) => textChannels === "all" || (Array.isArray(textChannels) && textChannels.includes(channel));

  /** The keyed reference for one Slack user. */
  function person(userId: string): string {
    return `slack_user:${createHmac("sha256", key).update(`karatos:correspondent:v1:slack:${userId}`, "utf8").digest("hex").slice(0, 32)}`;
  }

  /** Message text with people, contact details, numbers and link paths taken out. */
  function redact(text: string): { text: string; truncated: boolean } {
    const input = text.slice(0, SLACK_TEXT_INPUT_MAX);
    const out = input.replace(REDACT, (match: string, target: string | undefined) => {
      if (target === undefined) {
        if (match.includes("@")) return "[email]";
        return ISO_DATE.test(match) ? match : "[number]";
      }
      if (target.startsWith("@")) return USER_ID.test(target.slice(1)) ? `<@${person(target.slice(1))}>` : "[mention]";
      if (target.startsWith("#")) return SLACK_CHANNEL_ID.test(target.slice(1)) ? `<#${target.slice(1)}>` : "[channel]";
      if (/^!(here|channel|everyone)$/.test(target)) return `<${target}>`;
      if (target.startsWith("!")) return "[mention]";
      if (/^mailto:/i.test(target)) return "[email]";
      if (/^tel:/i.test(target)) return "[number]";
      if (/^https?:\/\//i.test(target)) {
        try {
          return `[link: ${new URL(target).hostname}]`;
        } catch {
          return "[link]";
        }
      }
      return "[link]";
    });
    const truncated = out.length > SLACK_TEXT_KEPT_MAX || text.length > SLACK_TEXT_INPUT_MAX;
    return { text: out.slice(0, SLACK_TEXT_KEPT_MAX), truncated };
  }

  function author(message: SlackMessage): { author?: string; authorKind: "person" | "bot" | "unknown" } {
    if (typeof message.user === "string" && USER_ID.test(message.user) && message.subtype !== "bot_message") return { author: person(message.user), authorKind: "person" };
    if (typeof message.bot_id === "string" && BOT_ID.test(message.bot_id)) return { author: `slack_bot:${message.bot_id}`, authorKind: "bot" };
    return { authorKind: "unknown" };
  }

  return {
    person,
    redact,
    keepsText,

    /**
     * One event per channel the bot is in. Names are kept unless they hold
     * four digits in a row (an order or phone number). Channels carry no
     * change time, so each is stamped when read and keyed by what's kept, so
     * a rename or archive is a new version.
     */
    channelEvents(channels: unknown, receivedAt: string): SlackBrainEvent[] {
      if (!Array.isArray(channels)) return [];
      return (channels as SlackChannel[]).flatMap((c) => {
        if (!c || typeof c.id !== "string" || !SLACK_CHANNEL_ID.test(c.id) || c.is_member !== true) return [];
        const raw = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "";
        const name = raw && !/\d{4}/.test(raw) ? raw : undefined;
        const kind = c.is_private === true ? "private" : "public";
        const archived = c.is_archived === true;
        const created = count(c.created);
        const payload = defined({
          channel: "slack",
          conversationId: slackRef("channel", c.id),
          kind,
          name,
          nameWithheld: name === undefined ? true : undefined,
          archived,
          createdAt: created !== undefined ? new Date(created * 1000).toISOString() : undefined,
          memberCount: count(c.num_members),
          textKept: keepsText(c.id),
        });
        const version = shortHash(`${kind}:${name ?? ""}:${archived}:${keepsText(c.id)}`);
        return [event(`channel:${c.id}:${version}`, "communication.channel_updated", receivedAt, receivedAt, payload)];
      });
    },

    /**
     * The event for one message, or none for a channel notice or a message
     * with no usable timestamp. The key is the channel, the timestamp and a
     * hash of its edit time and whether its text is kept, so an edit is a
     * new version, and a message seen by the sync and by a webhook, or
     * replayed, is stored once.
     */
    messageEvents(channel: string, message: SlackMessage, receivedAt: string): SlackBrainEvent[] {
      if (!message || typeof message !== "object" || !SLACK_CHANNEL_ID.test(channel) || !validTs(message.ts)) return [];
      if (message.subtype !== undefined && !(typeof message.subtype === "string" && SPOKEN.has(message.subtype))) return [];
      const ts = message.ts;
      const threadTs = validTs(message.thread_ts) ? message.thread_ts : undefined;
      const sentAt = slackTsToIso(ts);
      const files = Array.isArray(message.files) ? message.files.length : 0;
      const reactions = Array.isArray(message.reactions) ? message.reactions.reduce((n: number, r: { count?: unknown } | null) => n + (count(r?.count) ?? 0), 0) : 0;
      const editedTs = validTs(message.edited?.ts) ? message.edited!.ts : undefined;
      const textKept = keepsText(channel);
      const kept = textKept && typeof message.text === "string" ? redact(message.text) : undefined;
      const version = shortHash(`${editedTs ?? ""}:${textKept}`);
      return [
        event(`message:${channel}:${ts}:${version}`, "communication.message_logged", sentAt, receivedAt, defined({
          channel: "slack",
          conversationId: slackRef("channel", channel),
          messageId: slackRef("message", channel, ts),
          threadId: threadTs && slackRef("thread", channel, threadTs),
          isReply: threadTs !== undefined && threadTs !== ts,
          sentAt,
          ...author(message),
          kind: typeof message.subtype === "string" ? message.subtype : "message",
          replyCount: count(message.reply_count),
          fileCount: files,
          reactionCount: reactions,
          edited: editedTs !== undefined ? true : undefined,
          text: kept?.text,
          textTruncated: kept?.truncated ? true : undefined,
          textWithheld: kept === undefined ? true : undefined,
        })),
      ];
    },

    /** A message Slack says was deleted. */
    deletedEvent(channel: string, ts: unknown, receivedAt: string): SlackBrainEvent[] {
      if (!SLACK_CHANNEL_ID.test(channel) || !validTs(ts)) return [];
      return [event(`message:${channel}:${ts}:deleted`, "communication.message_deleted", receivedAt, receivedAt, { channel: "slack", conversationId: slackRef("channel", channel), messageId: slackRef("message", channel, ts) })];
    },
  };
}

export type SlackNormalizer = ReturnType<typeof slackNormalizer>;
