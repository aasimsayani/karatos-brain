import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";
import { quoTime } from "../openphone/normalize.js";
import { yextMasked } from "../yext/normalize.js";

/**
 * Turns Judge.me reviews into Brain A `review.updated` events, the shape the
 * Yext, Birdeye and Yotpo connectors give, so marketing and clienteling
 * read reviews from any of them the same way: the rating, the product it is
 * about, an excerpt and title with email addresses and phone numbers
 * masked, whether the reviewer was a verified buyer, and whether it is
 * published. A review of two stars or fewer is marked for follow-up.
 *
 * The reviewer's email address and phone number only make the keyed
 * customer references Shopify, Klaviyo and forms make, so a review links to
 * the same person's orders. Names, IP addresses and marketing tags are
 * never kept.
 *
 * Each event is keyed by the review and a digest of what was kept, so
 * reading it again is a duplicate and a change is a new event. A review
 * without an id, a rating or a time that reads is dead-lettered listing
 * what was wrong.
 */

export interface JudgemeEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const JUDGEME_REVIEW_EVENT = "review.updated";
/** A review rated this or lower is marked for follow-up. */
export const JUDGEME_FOLLOW_UP_RATING = 2;

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const time = (v: unknown) => quoTime(v) ?? undefined;
/** A short label, such as a source or a status, when it is one. */
const label = (v: unknown) => (typeof v === "string" && /^[a-z][a-z_-]{0,29}$/.test(v) ? v : undefined);

/** A Judge.me or platform id: a positive whole number, sent as a number or as digits. */
export function judgemeId(v: unknown): string | undefined {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
  return typeof v === "string" && /^[1-9]\d{0,19}$/.test(v) ? v : undefined;
}

export interface JudgemeContext {
  customerKey: string;
  receivedAt: string;
}

export type JudgemeRead = { ok: boolean; event: JudgemeEvent };

export function judgemeReviewEvent(raw: unknown, ctx: JudgemeContext): JudgemeRead {
  const problems: string[] = [];
  const r = isObject(raw) ? raw : {};
  const id = judgemeId(r.id);
  if (!id) problems.push("review has no id that reads");
  const rating = Number.isInteger(r.rating) && (r.rating as number) >= 1 && (r.rating as number) <= 5 ? (r.rating as number) : undefined;
  if (rating === undefined) problems.push("review has no rating from 1 to 5");
  const publishedAt = time(r.created_at);
  if (!publishedAt) problems.push("review has no time that reads");

  const reviewer = isObject(r.reviewer) ? r.reviewer : {};
  const reviewerId = judgemeId(reviewer.id);
  const productId = judgemeId(r.product_external_id);
  const pictures = Array.isArray(r.pictures) ? r.pictures : [];
  const payload: Record<string, unknown> = {
    system: "Judge.me",
    reviewId: id ? `judgeme:review:${id}` : undefined,
    publisher: "Judge.me",
    kind: productId ? "product" : "site",
    productId,
    rating,
    needsFollowUp: rating !== undefined && rating <= JUDGEME_FOLLOW_UP_RATING,
    title: yextMasked(r.title, 200),
    excerpt: yextMasked(r.body),
    source: label(r.source),
    curated: label(r.curated),
    verification: label(r.verified),
    verifiedBuyer: r.verified === "buyer",
    published: r.published === true && r.hidden !== true,
    hidden: r.hidden === true,
    photos: pictures.filter((p) => isObject(p) && p.hidden !== true).length,
    reviewerRef: reviewerId ? `judgeme:reviewer:${reviewerId}` : undefined,
    customerRefs: [...new Set(formCustomerRefs(ctx.customerKey, { email: reviewer.email, phone: reviewer.phone }))].sort(),
    publishedAt,
    editedAt: time(r.updated_at),
  };

  const ok = problems.length === 0;
  const key = ok ? `judgeme:review:${id}:${short(payload)}` : `judgeme:unreadable_review:${short(raw)}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type: JUDGEME_REVIEW_EVENT,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? publishedAt : undefined,
      receivedAt: ctx.receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: "Judge.me", reviewId: id ?? null, problems },
    },
  };
}
