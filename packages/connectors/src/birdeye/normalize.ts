import { createHash } from "node:crypto";
import { yextLink, yextMasked } from "../yext/normalize.js";

/**
 * Birdeye reviews as review.updated, the shape the Yext connector gives, so
 * marketing and clienteling read reviews from either the same way: the
 * rating, where it was posted, an excerpt, whether the store has replied,
 * and where to answer it.
 *
 * A review is written by a customer, so it keeps no reviewer name, photo or
 * Birdeye customer record, no custom fields and no staff names, and the
 * excerpt and title have email addresses and phone numbers masked. The
 * store's reply is noted, not copied.
 *
 * Each event is keyed by the review and a digest of what was kept, so an
 * edited or newly answered review is stored as a new version and an
 * unchanged one is a duplicate.
 */

export interface BirdeyeBrainEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A day Birdeye writes ("Jan 20, 2014", "01/20/2014" or an ISO time) as an ISO time, at midnight UTC for a bare day; undefined otherwise. */
export function birdeyeTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const v = value.trim();
  const words = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(v);
  const slashes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-](0\d|1[0-4]):[0-5]\d)$/.exec(v);
  let [y, m, d] = [0, 0, 0];
  if (words) [m, d, y] = [MONTHS.indexOf(words[1]!.toLowerCase()) + 1, Number(words[2]), Number(words[3])];
  else if (slashes) [m, d, y] = [Number(slashes[1]), Number(slashes[2]), Number(slashes[3])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return undefined;
  const day = new Date(Date.UTC(y, m - 1, d));
  // A day that doesn't exist (February 30th, a 13th month) is turned down rather than rolled over, as is one before 1970.
  if (y < 1970 || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return undefined;
  return iso ? new Date(Date.parse(v)).toISOString() : day.toISOString();
}

/** A day as Birdeye's filters take it. */
export const birdeyeDay = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
const word = (value: unknown, max = 40) => (typeof value === "string" && value.trim() && value.trim().length <= max && /^[A-Za-z0-9 ._-]+$/.test(value.trim()) ? value.trim() : undefined);

/** A rating from 0 to 5; Birdeye gives 0 for direct feedback and Facebook recommendations. */
export function birdeyeRating(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5 ? value : undefined;
}

/** A review as review.updated, or null without a usable id. */
export function birdeyeReviewEvent(review: Record<string, unknown>, ctx: { receivedAt: string; businessId: string }): BirdeyeBrainEvent | null {
  const raw = review?.reviewId;
  const reviewId = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? String(raw) : typeof raw === "string" && /^[1-9]\d{0,17}$/.test(raw) ? raw : undefined;
  if (!reviewId) return null;
  const replied = typeof review.response === "string" && review.response.trim() !== "";
  const operational = word(review.reviewOperationalStatus, 20)?.toUpperCase();
  const payload = defined({
    reviewId: `birdeye:review:${reviewId}`,
    locationId: `birdeye:business:${ctx.businessId}`,
    publisher: word(review.sourceType),
    rating: birdeyeRating(review.rating),
    title: yextMasked(review.title, 200),
    excerpt: yextMasked(review.comments),
    edited: operational === "UPDATED" ? true : operational === "CREATED" ? false : undefined,
    publishedAt: birdeyeTime(review.reviewDate),
    repliedAt: replied ? birdeyeTime(review.responseDate) : undefined,
    link: yextLink(review.reviewURL ?? review.reviewUrl),
    comments: replied ? 1 : 0,
    ownerReplies: replied ? 1 : 0,
    awaitingReply: !replied,
  });
  // Dated when it was posted; with no readable date, the pipeline dead-letters it.
  return {
    id: `birdeye_review_${reviewId}_${digest(payload)}`,
    type: "review.updated",
    occurredAt: payload.publishedAt as string | undefined,
    receivedAt: ctx.receivedAt,
    idempotencyKey: `birdeye:review:${reviewId}:${digest(payload)}`,
    payload,
  };
}
