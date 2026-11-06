import { createHash } from "node:crypto";

/**
 * Turns Yext locations and reviews into Brain A events:
 *
 * - location.updated: one of the store's locations, with its name, address,
 *   time zone and whether it is closed;
 * - review.updated: a review of a location from one of the publishers Yext
 *   watches (Google, Yelp, Facebook and others), with its rating, an
 *   excerpt, whether the store has replied, and where to answer it.
 *
 * A review changes when it is edited, replied to or taken down, so each
 * event is keyed by a digest of what was kept: a changed review is stored
 * as a new version, an unchanged one is a duplicate.
 *
 * A review is written by a customer, so it keeps no author name or email,
 * and the excerpt and title have email addresses and phone numbers masked.
 * Replies are counted, not copied.
 */

/** The raw event the pipeline receives; organizationId and source are added by runSync. */
export interface YextBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface YextContext {
  receivedAt: string;
}

export const YEXT_EVENTS = {
  location: "location.updated",
  review: "review.updated",
} as const;

/** How much of a review is kept. */
export const YEXT_EXCERPT_CHARS = 500;

export interface YextPage {
  items: Record<string, unknown>[];
  /** The token for the next page, present only when Yext gives one. */
  pageToken: string | undefined;
}

export class YextShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YextShapeError";
  }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const id = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === "string" && ID.test(value) ? value : undefined);
const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const word = (value: unknown) => (typeof value === "string" && /^[A-Za-z_ ]{1,40}$/.test(value) ? value : undefined);
export const yextRef = (kind: string, value: string) => `yext:${kind}:${value}`;

function event(key: string, type: string, occurredAt: string | undefined, receivedAt: string, payload: Record<string, unknown>): YextBrainEvent {
  return { id: `yext_${key.replace(/[^A-Za-z0-9_.:-]/g, "_")}`, type, occurredAt, receivedAt, idempotencyKey: `yext:${key}`, payload };
}

/** Whether a word is an email address: one @ with something before it, and a dot after it with something on each side. */
function isEmail(word: string): boolean {
  const at = word.indexOf("@");
  if (at < 1 || word.indexOf("@", at + 1) !== -1) return false;
  const dot = word.indexOf(".", at + 2);
  return dot !== -1 && dot < word.length - 1;
}
/** Seven or more digits, each apart from the next by at most two spaces, brackets, dots or dashes. */
const PHONE = /\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g;

/** Text a customer wrote, with email addresses and phone numbers masked and cut to `max`. */
export function yextMasked(value: unknown, max = YEXT_EXCERPT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  // Each word is checked for an email address without a pattern, and the phone pattern can't match one stretch
  // two ways, so masking takes time in step with the text's length.
  const masked = value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (isEmail(w) ? "[email]" : w))
    .join(" ")
    .replace(PHONE, "[phone]");
  return masked ? masked.slice(0, max) : undefined;
}

/** A time Yext gives in epoch milliseconds, or as an ISO string, as an ISO time; undefined when it is neither. */
export function yextTime(value: unknown): string | undefined {
  const ms = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A review's page on its publisher's site, without a query string. Undefined for anything but an https address. */
export function yextLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  return `${url.origin}${url.pathname}`.slice(0, 500);
}

/** A rating from 0 to 10, as Yext gives them (most publishers 1 to 5). */
export function yextRating(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10 ? value : undefined;
}

/** One page of a list. A body without the list throws, so a sync never skips records unseen. */
export function yextPage(body: unknown, list: "entities" | "reviews"): YextPage {
  const response = obj(obj(body).response);
  const items = response[list];
  if (!Array.isArray(items)) throw new YextShapeError(`Yext answered without ${list}`);
  const next = list === "entities" ? response.pageToken : response.nextPageToken;
  return { items: items.map(obj), pageToken: typeof next === "string" && next ? next : undefined };
}

/** A location as location.updated, or null without an id. */
export function yextLocationEvent(entity: Record<string, unknown>, ctx: YextContext): YextBrainEvent | null {
  const meta = obj(entity?.meta);
  const locationId = id(meta.id);
  if (!locationId) return null;
  const address = obj(entity.address);
  const payload = defined({
    locationId: yextRef("location", locationId),
    name: text(entity.name, 200),
    line1: text(address.line1, 200),
    city: text(address.city, 100),
    region: text(address.region, 100),
    postalCode: text(address.postalCode, 20),
    countryCode: typeof address.countryCode === "string" && /^[A-Z]{2}$/.test(address.countryCode) ? address.countryCode : undefined,
    timezone: typeof entity.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(entity.timezone) ? entity.timezone : undefined,
    closed: typeof entity.closed === "boolean" ? entity.closed : undefined,
  });
  // Dated when Yext last changed it, or when it was read if Yext doesn't say.
  return event(`location:${locationId}:${digest(payload)}`, YEXT_EVENTS.location, yextTime(meta.timestamp) ?? ctx.receivedAt, ctx.receivedAt, payload);
}

/** A review as review.updated, or null without an id. */
export function yextReviewEvent(review: Record<string, unknown>, ctx: YextContext): YextBrainEvent | null {
  const reviewId = id(review?.id);
  if (!reviewId) return null;
  const location = id(review.locationId ?? review.entityId);
  const comments = Array.isArray(review.comments) ? review.comments.map(obj) : [];
  const replies = comments.filter((c) => c.authorRole === "BUSINESS_OWNER").length;
  const status = word(review.status);
  const publishedAt = yextTime(review.publisherDate);
  const updatedAt = yextTime(review.lastYextUpdateTime);
  const payload = defined({
    reviewId: yextRef("review", reviewId),
    locationId: location && yextRef("location", location),
    publisher: id(review.publisherId),
    rating: yextRating(review.rating),
    reviewType: word(review.reviewType),
    recommendation: word(review.recommendation),
    title: yextMasked(review.title, 200),
    excerpt: yextMasked(review.content),
    language: typeof review.reviewLanguage === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(review.reviewLanguage) ? review.reviewLanguage : undefined,
    status,
    publishedAt,
    updatedAt,
    link: yextLink(review.url),
    comments: comments.length,
    ownerReplies: replies,
    awaitingReply: replies === 0 && status !== "REMOVED",
  });
  // Dated when it was published, or last updated if the publisher gives no date; with neither, the pipeline dead-letters it.
  return event(`review:${reviewId}:${digest(payload)}`, YEXT_EVENTS.review, publishedAt ?? updatedAt, ctx.receivedAt, payload);
}
