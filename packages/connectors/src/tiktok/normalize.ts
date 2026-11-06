import { createHash } from "node:crypto";

/**
 * Turns TikTok's profile and video list into Brain A events:
 *
 * - social.account_reported: the account's followers, accounts followed,
 *   total likes and video count, as read on one day;
 * - social.video_updated: one of the store's public videos, with its title,
 *   its link, how long it runs and its views, likes, comments and shares.
 *
 * Counts keep growing after a video is posted, so each event is keyed by a
 * digest of its numbers: a video whose counts moved is stored as a new
 * version, an unchanged one is a duplicate.
 *
 * Nothing here names a customer. A video's description isn't read, a title
 * holding an @ is dropped, and a link keeps only a tiktok.com address
 * without its query string.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface TikTokBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface TikTokContext {
  receivedAt: string;
}

export const TIKTOK_EVENTS = {
  account: "social.account_reported",
  video: "social.video_updated",
} as const;

export interface TikTokVideoPage {
  videos: Record<string, unknown>[];
  /** The cursor for the next page, present only when TikTok says there is more. */
  cursor: number | undefined;
}

export class TikTokShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const videoId = (value: unknown) => (typeof value === "string" && /^\d{1,25}$/.test(value) ? value : undefined);
export const tiktokRef = (kind: string, id: string) => `tiktok:${kind}:${id}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): TikTokBrainEvent {
  return { id: `tiktok_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `tiktok:${key}`, payload };
}

/** A count: a whole, non-negative JSON number. Undefined for anything else. */
export function tiktokCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A video's title or the account's name, cut short; dropped if it holds an @. */
export function tiktokLabel(value: unknown, max = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t || t.includes("@")) return undefined;
  return t.slice(0, max);
}

/** A video's share link, as a tiktok.com address without its query string. Undefined for anything else. */
export function tiktokLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !(url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com"))) return undefined;
  return `${url.origin}${url.pathname}`.slice(0, 300);
}

/** When a video was posted, from TikTok's create_time in epoch seconds, as an ISO time; undefined when it isn't one. */
export function tiktokTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** One page of videos. A body that isn't one throws, so a sync never skips videos unseen. */
export function tiktokVideoPage(body: unknown): TikTokVideoPage {
  const data = obj(obj(body).data);
  if (!Array.isArray(data.videos)) throw new TikTokShapeError("TikTok answered the video list without videos");
  const more = data.has_more === true;
  if (more && !(typeof data.cursor === "number" && Number.isSafeInteger(data.cursor) && data.cursor > 0)) throw new TikTokShapeError("TikTok said there are more videos without a cursor for them");
  return { videos: data.videos.map(obj), cursor: more ? (data.cursor as number) : undefined };
}

/** A video as social.video_updated, or null without an id. */
export function tiktokVideoEvent(video: Record<string, unknown>, ctx: TikTokContext): TikTokBrainEvent | null {
  const id = videoId(video?.id);
  if (!id) return null;
  const postedAt = tiktokTime(video.create_time);
  const payload = defined({
    videoId: tiktokRef("video", id),
    postedAt,
    title: tiktokLabel(video.title),
    link: tiktokLink(video.share_url),
    durationSeconds: tiktokCount(video.duration),
    views: tiktokCount(video.view_count),
    likes: tiktokCount(video.like_count),
    comments: tiktokCount(video.comment_count),
    shares: tiktokCount(video.share_count),
  });
  // Dated when it was posted, since TikTok gives no change time; moved counts are a new version of the same date.
  return event(`video:${id}:${digest(payload)}`, TIKTOK_EVENTS.video, postedAt, ctx.receivedAt, payload);
}

/** The account's counts on `day` (YYYY-MM-DD) as social.account_reported. A body without a user throws. */
export function tiktokAccountEvent(body: unknown, day: string, ctx: TikTokContext): TikTokBrainEvent {
  const user = obj(obj(body).data).user;
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new TikTokShapeError("TikTok answered the profile read without a user");
  const u = user as Record<string, unknown>;
  const payload = defined({
    day,
    name: tiktokLabel(u.display_name),
    followers: tiktokCount(u.follower_count),
    following: tiktokCount(u.following_count),
    likes: tiktokCount(u.likes_count),
    videos: tiktokCount(u.video_count),
  });
  return event(`account:${day}:${digest(payload)}`, TIKTOK_EVENTS.account, `${day}T00:00:00.000Z`, ctx.receivedAt, payload);
}
