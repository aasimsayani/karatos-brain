import { createHash } from "node:crypto";
import { quoTime } from "../openphone/normalize.js";
import { yextMasked } from "../yext/normalize.js";

/**
 * Turns Trustpilot's public service reviews into Brain A `review.updated`
 * events, the shape the Yext, Birdeye, Yotpo and Judge.me connectors give,
 * so marketing and clienteling read reviews from any of them the same way:
 * the rating, an excerpt and title with email addresses and phone numbers
 * masked, whether Trustpilot verified it, whether the store has replied,
 * and when. A review of two stars or fewer is marked for follow-up, and one
 * the store hasn't replied to is marked as waiting on a reply.
 *
 * Only what is public on the store's Trustpilot page is read. The
 * reviewer's display name and location are never kept; the reviewer is
 * Trustpilot's consumer id, which names no one outside Trustpilot. The
 * store's reply text isn't kept either, only that it replied and when.
 *
 * The store's trust score and review counts become a `review.score_updated`
 * event, keyed by a digest of what was read, so a score that hasn't moved
 * is a duplicate.
 *
 * Each review event is keyed by the review and a digest of what was kept,
 * so reading it again is a duplicate and a change (an edit, a reply) is a
 * new event. A review without an id, a rating or a time that reads is
 * dead-lettered listing what was wrong.
 */

export interface TrustpilotEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const TRUSTPILOT_REVIEW_EVENT = "review.updated";
export const TRUSTPILOT_SCORE_EVENT = "review.score_updated";
/** A review rated this or lower is marked for follow-up. */
export const TRUSTPILOT_FOLLOW_UP_RATING = 2;
const SYSTEM = "Trustpilot";

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const time = (v: unknown) => quoTime(v) ?? undefined;
/** A Trustpilot id: 24 hexadecimal characters. */
const tpId = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{24}$/.test(v) ? v : undefined);
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
/** A score from 0 to 5, such as 4.6. */
const score = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 5 ? v : undefined);
/** A short label, such as a status or a language. */
const label = (v: unknown) => (typeof v === "string" && /^[A-Za-z][A-Za-z_-]{0,19}$/.test(v) ? v : undefined);

export interface TrustpilotContext {
  businessUnitId: string;
  receivedAt: string;
}

export type TrustpilotRead = { ok: boolean; event: TrustpilotEvent };

export function trustpilotReviewEvent(raw: unknown, ctx: TrustpilotContext): TrustpilotRead {
  const problems: string[] = [];
  const r = obj(raw);
  if (r !== raw) problems.push("review is not an object");
  const id = tpId(r.id);
  if (!id) problems.push("review has no id that reads");
  const rating = Number.isInteger(r.stars) && (r.stars as number) >= 1 && (r.stars as number) <= 5 ? (r.stars as number) : undefined;
  if (rating === undefined) problems.push("review has no rating from 1 to 5");
  const publishedAt = time(r.createdAt);
  if (!publishedAt) problems.push("review has no time that reads");

  const reply = obj(r.companyReply);
  const repliedAt = time(reply.createdAt);
  const payload: Record<string, unknown> = {
    system: SYSTEM,
    reviewId: `trustpilot:review:${id}`,
    publisher: SYSTEM,
    kind: "site",
    locationId: `trustpilot:business_unit:${ctx.businessUnitId}`,
    storeLocationId: tpId(obj(r.location).id),
    rating,
    // A review without a rating is dead-lettered, so this is only read when there is one.
    needsFollowUp: rating! <= TRUSTPILOT_FOLLOW_UP_RATING,
    title: yextMasked(r.title, 200),
    excerpt: yextMasked(r.text),
    language: label(r.language),
    status: label(r.status),
    verified: r.isVerified === true,
    countsTowardsTrustScore: typeof r.countsTowardsTrustScore === "boolean" ? r.countsTowardsTrustScore : undefined,
    likes: count(r.numberOfLikes),
    reviewerRef: tpId(obj(r.consumer).id) ? `trustpilot:consumer:${obj(r.consumer).id}` : undefined,
    ownerReplies: repliedAt ? 1 : 0,
    awaitingReply: !repliedAt,
    repliedAt,
    replyEditedAt: repliedAt ? time(reply.updatedAt) : undefined,
    experiencedAt: time(r.experiencedAt),
    publishedAt,
    editedAt: time(r.updatedAt),
  };

  const ok = problems.length === 0;
  const key = ok ? `trustpilot:review:${id}:${short(payload)}` : `trustpilot:unreadable_review:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type: TRUSTPILOT_REVIEW_EVENT,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? publishedAt : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, reviewId: id ?? null, problems },
    },
  };
}

/** The store's trust score and review counts, dated when they were read. */
export function trustpilotScoreEvent(raw: unknown, ctx: TrustpilotContext): TrustpilotRead {
  const problems: string[] = [];
  const u = obj(raw);
  if (u !== raw) problems.push("business unit is not an object");
  if (u.id !== ctx.businessUnitId) problems.push("business unit is not the store's");
  const s = obj(u.score);
  const trustScore = score(s.trustScore);
  if (trustScore === undefined) problems.push("business unit has no trust score from 0 to 5");
  const n = obj(u.numberOfReviews);
  const total = count(n.total);
  if (total === undefined) problems.push("business unit has no review count that reads");

  const payload: Record<string, unknown> = {
    system: SYSTEM,
    publisher: SYSTEM,
    locationId: `trustpilot:business_unit:${ctx.businessUnitId}`,
    trustScore,
    stars: score(s.stars),
    reviews: total,
    reviewsInScore: count(n.usedForTrustScoreCalculation),
    byRating: { 1: count(n.oneStar), 2: count(n.twoStars), 3: count(n.threeStars), 4: count(n.fourStars), 5: count(n.fiveStars) },
  };
  const ok = problems.length === 0;
  const key = ok ? `trustpilot:score:${ctx.businessUnitId}:${short(payload)}` : `trustpilot:unreadable_score:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type: TRUSTPILOT_SCORE_EVENT,
      occurredAt: ok ? ctx.receivedAt : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: SYSTEM, problems },
    },
  };
}
