import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Drive and Calendar push notifications. Google doesn't sign them: each is
 * an empty POST whose headers name the channel (X-Goog-Channel-ID), the
 * watched resource (X-Goog-Resource-ID), what happened
 * (X-Goog-Resource-State) and a message number, and echo back the token the
 * channel was opened with (X-Goog-Channel-Token). So a delivery is genuine
 * only if its token matches this instance's (GOOGLE_PUSH_CHANNEL_TOKEN,
 * compared in constant time) and it names a channel and resource the
 * instance opened and that hasn't expired. A notification carries no data;
 * it is a prompt to run the incremental sync, which reads the change itself.
 *
 * Message numbers grow with each notification on a channel (not one by
 * one), so a number at or below the last one seen is a replay and is
 * refused; a replay that got through anyway would only prompt a sync that
 * finds nothing new.
 *
 * Opening a channel (changes.watch, events.watch) is a POST that creates
 * state in the business's Google account and points Google at the
 * instance. It stays behind the write gate (watch_drive_changes,
 * watch_calendar_events), so until an owner turns it on no channel exists
 * and every delivery is refused as an unknown channel.
 */

export interface GooglePushChannel {
  /** The id the channel was opened with: up to 64 characters. */
  id: string;
  kind: "drive" | "calendar";
  /** Google's id for the watched resource, from the watch answer. Checked when known. */
  resourceId?: string;
  /** Milliseconds since the epoch when the channel ends. */
  expiration?: number;
}

export type GooglePushCheck =
  | { ok: true; channelId: string; kind: GooglePushChannel["kind"]; state: string; messageNumber: string; /** True for the sync message Google sends when a channel opens: nothing changed. */ sync: boolean }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" | "unknown_channel" | "expired" | "replayed" | "unexpected_state" };

export interface GooglePushVerifierOptions {
  /** GOOGLE_PUSH_CHANNEL_TOKEN: the token every channel is opened with. At least 32 characters. */
  channelToken: string;
  channels: readonly GooglePushChannel[];
  /** The last message number seen per channel id, so a restart keeps refusing replays. */
  lastSeen?: Record<string, string>;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
}

/** The states Google documents for each kind of channel. */
export const GOOGLE_PUSH_STATES = {
  drive: ["sync", "add", "remove", "update", "trash", "untrash", "change"],
  calendar: ["sync", "exists", "not_exists"],
} as const;

const TOKEN = /^[\x21-\x7e]{1,256}$/;
const CHANNEL_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MESSAGE_NUMBER = /^\d{1,20}$/;
const STATE = /^[a-z_]{1,20}$/;

type HeaderSource = Headers | Readonly<Record<string, string | string[] | undefined>>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? undefined : value;
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** Compares two tokens in constant time, whatever their lengths. */
export function sameChannelToken(expected: string, given: string): boolean {
  const a = digest(expected);
  const b = digest(given);
  return timingSafeEqual(a, b) && expected.length === given.length;
}

/**
 * A verifier for one instance's push channels. Check every delivery with it
 * before acting on it; it remembers the highest message number per channel.
 */
export function googlePushVerifier(options: GooglePushVerifierOptions) {
  const secret = options.channelToken?.trim() ?? "";
  if (secret.length < 32 || !TOKEN.test(secret)) throw new Error("set GOOGLE_PUSH_CHANNEL_TOKEN to at least 32 printable characters; npm run secrets:setup generates one");
  const clock = options.clock ?? (() => Date.now());
  const lastSeen = new Map(Object.entries(options.lastSeen ?? {}));

  return {
    /** The last message number seen per channel, to keep across restarts. */
    lastSeen: () => Object.fromEntries(lastSeen),

    verify(headers: HeaderSource): GooglePushCheck {
      const token = header(headers, "x-goog-channel-token");
      const channelId = header(headers, "x-goog-channel-id");
      const state = header(headers, "x-goog-resource-state");
      const number = header(headers, "x-goog-message-number");
      const resourceId = header(headers, "x-goog-resource-id");
      if (!token || !channelId || !state || !number || !resourceId) return { ok: false, reason: "missing" };
      // Every header is length-capped by its pattern's own bounds before anything else is done with it.
      if (token.length > 256 || !TOKEN.test(token) || channelId.length > 64 || !CHANNEL_ID.test(channelId) || resourceId.length > 200 || !RESOURCE_ID.test(resourceId) || number.length > 20 || !MESSAGE_NUMBER.test(number) || state.length > 20 || !STATE.test(state)) {
        return { ok: false, reason: "malformed" };
      }
      if (!sameChannelToken(secret, token)) return { ok: false, reason: "mismatch" };
      const channel = options.channels.find((c) => c.id === channelId);
      if (!channel || (channel.resourceId !== undefined && channel.resourceId !== resourceId)) return { ok: false, reason: "unknown_channel" };
      if (channel.expiration !== undefined && channel.expiration <= clock()) return { ok: false, reason: "expired" };
      if (!(GOOGLE_PUSH_STATES[channel.kind] as readonly string[]).includes(state)) return { ok: false, reason: "unexpected_state" };
      const previous = lastSeen.get(channelId);
      if (previous !== undefined && BigInt(number) <= BigInt(previous)) return { ok: false, reason: "replayed" };
      lastSeen.set(channelId, number);
      return { ok: true, channelId, kind: channel.kind, state, messageNumber: number, sync: state === "sync" };
    },
  };
}

export type GooglePushVerifier = ReturnType<typeof googlePushVerifier>;
