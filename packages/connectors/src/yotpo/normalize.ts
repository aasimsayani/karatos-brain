import { createHash } from "node:crypto";
import { formCustomerRefs } from "../custom_forms/customer.js";
import { quoTime } from "../openphone/normalize.js";
import { yextMasked } from "../yext/normalize.js";

/**
 * Turns Yotpo reviews and Loyalty customers into Brain A events:
 *
 * - each review as `review.updated`, the shape the Yext and Birdeye
 *   connectors give, so marketing and clienteling read reviews from any of
 *   them the same way: the rating, the product it is about, an excerpt and
 *   title with email addresses and phone numbers masked, whether it was
 *   verified or incentivized, and whether it is published;
 * - each Loyalty customer as `loyalty.customer_updated`: the points
 *   balance, what was earned and redeemed, the VIP tier, and what they
 *   have spent.
 *
 * The reviewer's or member's email address and phone number only make the
 * keyed customer references custom forms, Klaviyo and Calendly make, so a
 * review or a balance links to the same person's bookings and orders.
 * Names, birthdays, anniversaries and referral links are never kept.
 *
 * Each event is keyed by the review or member and a digest of what was
 * kept, so reading it again is a duplicate and a change is a new event. A
 * review or member without an id, or a review without a rating or a time
 * that reads, is dead-lettered listing what was wrong.
 */

export interface YotpoEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export const YOTPO_REVIEW_EVENT = "review.updated";
export const YOTPO_LOYALTY_EVENT = "loyalty.customer_updated";
/** The sku Yotpo gives a review of the store itself rather than a product. */
const SITE_SKU = "yotpo_site_reviews";
const INCENTIVES = new Set(["free_product", "coupon", "loyalty_points", "paid_promotion", "employee_review", "other"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
const time = (v: unknown) => quoTime(v) ?? undefined;
/** A short label, such as a sku or a tier name, when it is one. */
const label = (v: unknown, max = 60) => (typeof v === "string" && v.trim().length <= max && /^[\p{L}\p{N} ._/+#&-]+$/u.test(v.trim()) ? v.trim() : undefined);
/** A Yotpo id: a positive whole number, sent as a number or as digits. */
export function yotpoId(v: unknown): string | undefined {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? String(v) : undefined;
  return typeof v === "string" && /^[1-9]\d{0,17}$/.test(v) ? v : undefined;
}

/** Text as Yotpo writes it, with its HTML entities (&#x27;, &amp;) read back. */
export function yotpoText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : lower.startsWith("#") ? Number(lower.slice(1)) : NaN;
    if (!Number.isNaN(code)) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    return ENTITIES[lower] ?? whole;
  });
}

export interface YotpoContext {
  customerKey: string;
  receivedAt: string;
}

export type YotpoRead = { ok: boolean; event: YotpoEvent };

function read(kind: "review" | "loyalty_customer", type: string, raw: unknown, problems: string[], id: string | undefined, at: string | undefined, payload: Record<string, unknown>, receivedAt: string): YotpoRead {
  const ok = problems.length === 0;
  const hash = ok ? short(payload) : short(raw);
  const key = ok ? `yotpo:${kind}:${id}:${hash}` : `yotpo:unreadable_${kind}:${hash}`;
  return {
    ok,
    event: {
      id: key.replace(/:/g, "_"),
      type,
      // One with a problem has no time, so it is dead-lettered.
      occurredAt: ok ? at : undefined,
      receivedAt,
      idempotencyKey: key,
      payload: ok ? payload : { system: "Yotpo", [kind === "review" ? "reviewId" : "loyaltyCustomerId"]: id ?? null, problems },
    },
  };
}

export function yotpoReviewEvent(raw: unknown, ctx: YotpoContext): YotpoRead {
  const problems: string[] = [];
  const r = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("review is not an object");
  const id = yotpoId(r.id);
  if (!id) problems.push("review has no id that reads");
  const rating = Number.isInteger(r.score) && (r.score as number) >= 1 && (r.score as number) <= 5 ? (r.score as number) : undefined;
  if (rating === undefined) problems.push("review has no rating from 1 to 5");
  const publishedAt = time(r.created_at);
  if (!publishedAt) problems.push("review has no time that reads");

  const site = r.sku === SITE_SKU;
  const sentiment = typeof r.sentiment === "number" && r.sentiment >= 0 && r.sentiment <= 1 ? r.sentiment : undefined;
  const payload: Record<string, unknown> = {
    system: "Yotpo",
    reviewId: id ? `yotpo:review:${id}` : undefined,
    publisher: "Yotpo",
    kind: site ? "site" : "product",
    productSku: site ? undefined : label(r.sku),
    rating,
    title: yextMasked(yotpoText(r.title), 200),
    excerpt: yextMasked(yotpoText(r.content)),
    sentiment,
    verifiedBuyer: r.reviewer_type === "verified_buyer",
    incentivized: r.is_incentivized === true,
    incentiveType: typeof r.incentive_type === "string" && INCENTIVES.has(r.incentive_type) ? r.incentive_type : undefined,
    votesUp: count(r.votes_up),
    votesDown: count(r.votes_down),
    published: r.deleted !== true && r.archived !== true,
    escalated: r.escalated === true,
    customerRefs: formCustomerRefs(ctx.customerKey, { email: r.email }),
    publishedAt,
    editedAt: time(r.updated_at),
  };
  return read("review", YOTPO_REVIEW_EVENT, raw, problems, id, publishedAt, payload, ctx.receivedAt);
}

export function yotpoLoyaltyEvent(raw: unknown, ctx: YotpoContext): YotpoRead {
  const problems: string[] = [];
  const c = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("customer is not an object");
  const id = yotpoId(c.yotpo_customer_id);
  if (!id) problems.push("customer has no id that reads");
  const payload: Record<string, unknown> = {
    system: "Yotpo",
    loyaltyCustomerId: id ? `yotpo:loyalty_customer:${id}` : undefined,
    customerRefs: [...new Set(formCustomerRefs(ctx.customerKey, { email: c.email, phone: c.phone_number }))].sort(),
    pointsBalance: count(c.points_balance),
    pointsEarned: count(c.points_earned),
    pointsExpireAt: time(c.points_expire_at),
    perksRedeemed: count(c.perks_redeemed),
    vipTier: label(c.vip_tier_name, 40),
    vipTierSince: time(c.vip_tier_entry_date),
    vipTierUntil: time(c.vip_tier_expiration),
    totalSpendCents: count(c.total_spend_cents),
    totalPurchases: count(c.total_purchases),
    lastPurchaseAt: time(c.last_purchase_at),
    lastSeenAt: time(c.last_seen_at),
    optedIn: c.opt_in === true,
    hasStoreAccount: c.has_store_account === true,
  };
  // Yotpo gives no change time, so a balance is dated when it was read.
  return read("loyalty_customer", YOTPO_LOYALTY_EVENT, raw, problems, id, ctx.receivedAt, payload, ctx.receivedAt);
}
